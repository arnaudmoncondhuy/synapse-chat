<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Core\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmAuthenticationException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmQuotaException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmRateLimitException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmServiceUnavailableException;
use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Shared\Enum\MessageRole;
use ArnaudMoncondhuy\SynapseCore\Core\Chat\ChatService;
use ArnaudMoncondhuy\SynapseCore\Core\Formatter\MessageFormatter;
use ArnaudMoncondhuy\SynapseCore\Core\Manager\ConversationManager;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Profiler\Profiler;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;

/**
 * Contrôleur API principal pour le flux de conversation.
 *
 * Ce contrôleur expose le endpoint `/synapse/api/chat` qui gère les échanges
 * en temps réel avec le frontend via un flux NDJSON (Streamed Response).
 */
#[Route('/synapse/api')]
class ChatApiController extends AbstractController
{
    public function __construct(
        private ChatService $chatService,
        private PermissionCheckerInterface $permissionChecker,
        private ?ConversationManager $conversationManager = null,
        private ?MessageFormatter $messageFormatter = null,
        private ?CsrfTokenManagerInterface $csrfTokenManager = null,
        private ?\ArnaudMoncondhuy\SynapseCore\Core\Accounting\TokenAccountingService $tokenAccountingService = null,
        private ?\ArnaudMoncondhuy\SynapseCore\Core\Accounting\TokenCostEstimator $tokenCostEstimator = null,
    ) {}

    /**
     * Traite une nouvelle requête de chat et retourne un flux d'événements.
     *
     * IMPORTANT : Ce endpoint utilise 'Content-Type: application/x-ndjson' pour supporter
     * le streaming progressif des étapes (analyse, outils, réponse).
     *
     * Mécanismes clés :
     * 1. Désactivation du Symfony Profiler pour éviter la pollution du JSON.
     * 2. Clôture immédiate de la session (session_write_close) pour éviter le verrouillage (Session Blocking) si d'autres parties de l'application utilisent les sessions PHP.
     *
     * @param Request       $request  la requête HTTP contenant le message JSON
     * @param Profiler|null $profiler le profiler Symfony (injecté si disponible)
     *
     * @return StreamedResponse une réponse HTTP dont le contenu est envoyé chunk par chunk
     */
    #[Route('/chat', name: 'synapse_api_chat', methods: ['POST'])]
    public function chat(Request $request, ?Profiler $profiler): StreamedResponse
    {
        // CSRF Check (désactivable via synapse.security.api_csrf_enabled: false)
        if ($this->getParameter('synapse.security.api_csrf_enabled') && $this->csrfTokenManager) {
            $token = $request->headers->get('X-CSRF-Token') ?? $request->request->get('_csrf_token');
            $token = (string) $token;
            if ($token === '') {
                throw $this->createAccessDeniedException(
                    'Jeton CSRF manquant. Le front doit envoyer X-CSRF-Token (récupéré via GET /synapse/api/csrf-token). Sinon : synapse.security.api_csrf_enabled: false dans config.'
                );
            }
            if (!$this->isCsrfTokenValid('synapse_api', $token)) {
                throw $this->createAccessDeniedException('Jeton CSRF invalide ou expiré. Rechargez la page (F5).');
            }
        }

        // Permission check: Can start/continue chat?
        if (!$this->permissionChecker->canCreateConversation()) {
            throw $this->createAccessDeniedException('Not allowed to start a conversation.');
        }

        // 1. On désactive le profiler pour ne pas casser le flux JSON
        if ($profiler) {
            $profiler->disable();
        }

        $data = json_decode($request->getContent(), true) ?? [];
        $message = $data['message'] ?? '';
        $options = $data['options'] ?? [];
        $options['debug'] = $data['debug'] ?? ($options['debug'] ?? false);
        $conversationId = $data['conversation_id'] ?? null;
        $options['conversation_id'] = $conversationId;  // Pass to ChatService for debug logging

        // Load conversation if ID provided and persistence enabled
        $conversation = null;
        if ($conversationId && $this->conversationManager) {
            $user = $this->getUser();
            if ($user instanceof ConversationOwnerInterface) {
                $conversation = $this->conversationManager->getConversation($conversationId, $user);
                if ($conversation) {
                    if (!$this->permissionChecker->canView($conversation)) {
                        throw $this->createAccessDeniedException('Access Denied to this conversation.');
                    }
                    $this->conversationManager->setCurrentConversation($conversation);
                }
            }
        }

        $response = new StreamedResponse(function () use ($message, $options, $conversation) {
            // CRITICAL: Disable ALL output buffering to prevent Symfony Debug Toolbar injection
            // The toolbar tries to inject HTML into buffered output, corrupting NDJSON stream
            while (ob_get_level() > 0) {
                ob_end_clean();
            }
            ob_implicit_flush(true);

            // Helper to send NDJSON event
            $sendEvent = function (string $type, mixed $payload): void {
                echo json_encode(['type' => $type, 'payload' => $payload], JSON_INVALID_UTF8_IGNORE | JSON_THROW_ON_ERROR) . "\n";
                // Force flush explicitly
                if (ob_get_length() > 0) {
                    ob_flush();
                }
                flush();
            };

            // Send padding to bypass browser/proxy buffering (approx 2KB)
            echo ":" . str_repeat(' ', 2048) . "\n";
            flush();

            if (empty($message) && !($options['reset_conversation'] ?? false)) {
                $sendEvent('error', 'SynapseMessage is required.');

                return;
            }

            try {
                // Create or get conversation if persistence enabled
                if ($this->conversationManager && !$conversation && !empty($message)) {
                    $user = $this->getUser();
                    if ($user instanceof ConversationOwnerInterface) {
                        $conversation = $this->conversationManager->createConversation($user);
                        $this->conversationManager->setCurrentConversation($conversation);
                    }
                }

                // Load conversation history from database if persistence enabled (WITHOUT new message)
                if ($conversation && $this->conversationManager) {
                    $dbMessages = $this->conversationManager->getMessages($conversation);

                    // Convert DB messages to ChatService format using formatter (handles decryption)
                    if ($this->messageFormatter) {
                        $options['history'] = $this->messageFormatter->entitiesToApiFormat($dbMessages);
                    } else {
                        // Fallback (legacy risks sending encrypted content)
                        $options['history'] = $dbMessages;
                    }
                }

                // Status update callback for streaming
                $onStatusUpdate = function (string $statusMessage, string $step) use ($sendEvent): void {
                    $sendEvent('status', ['message' => $statusMessage, 'step' => $step]);
                };

                // Token streaming callback
                $onToken = function (string $token) use ($sendEvent): void {
                    $sendEvent('delta', ['text' => $token]);
                };

                // Tool executed callback — envoie un événement immédiat pour les outils
                $onToolExecuted = function (string $toolName, mixed $toolResult) use ($sendEvent, $conversation): void {
                    $isProposeToRemember = $toolName === 'propose_to_remember' || str_ends_with($toolName, 'propose_to_remember');
                    if ($isProposeToRemember && \is_array($toolResult) && ($toolResult['__synapse_action'] ?? '') === 'memory_proposal') {
                        $sendEvent('tool_executed', [
                            'tool' => 'propose_to_remember',
                            'proposal' => $toolResult,
                            'conversation_id' => $conversation?->getId(),
                        ]);
                    }
                };

                // Pass user_id for spending limit checks
                $user = $this->getUser();
                if ($user instanceof ConversationOwnerInterface) {
                    $options['user_id'] = (string) $user->getId();
                }

                // Estimate cost for spending limit check (before LLM call)
                if ($this->tokenCostEstimator !== null) {
                    $estimateContents = $options['history'] ?? [];
                    if ($message !== '') {
                        $estimateContents[] = ['role' => 'user', 'content' => $message];
                    }
                    if (!empty($estimateContents)) {
                        $estimate = $this->tokenCostEstimator->estimateCost($estimateContents);
                        $options['estimated_cost_reference'] = $estimate['cost_reference'];
                    }
                }

                // Execute chat (ChatService will handle adding the new user message to history)
                $result = $this->chatService->ask($message, $options, $onStatusUpdate, $onToken, $onToolExecuted);

                // Save BOTH user message and assistant response to database after processing
                if ($conversation && $this->conversationManager) {
                    // Save user message (pas d'appel LLM associé)
                    if (!empty($message)) {
                        $this->conversationManager->saveMessage($conversation, MessageRole::USER, $message);
                    }

                    // Save assistant message + log LLM call
                    if (!empty($result['answer'])) {
                        $usage = $result['usage'] ?? [];
                        $metadata = [
                            'prompt_tokens'     => $usage['prompt_tokens'] ?? 0,
                            'completion_tokens' => $usage['completion_tokens'] ?? 0,
                            'thinking_tokens'   => $usage['thinking_tokens'] ?? 0,
                            'safety_ratings'    => $result['safety'] ?? null,
                            'model'             => $result['model'] ?? null,
                            'preset_id'         => $result['preset_id'] ?? null,
                            'metadata'          => ['debug_id' => $result['debug_id'] ?? null],
                        ];

                        // Log l'appel LLM dans synapse_llm_call et récupérer le callId
                        $callId = null;
                        if ($this->tokenAccountingService !== null) {
                            $llmCall = $this->tokenAccountingService->logUsage(
                                'chat',
                                'chat_turn',
                                $result['model'] ?? 'unknown',
                                [
                                    'prompt_tokens'     => $usage['prompt_tokens'] ?? 0,
                                    'completion_tokens' => $usage['completion_tokens'] ?? 0,
                                    'thinking_tokens'   => $usage['thinking_tokens'] ?? 0,
                                ],
                                $user instanceof ConversationOwnerInterface ? (string) $user->getId() : null,
                                $conversation->getId(),
                                $result['preset_id'] ?? null,
                                $result['mission_id'] ?? null
                            );
                            $callId = $llmCall->getCallId();
                        }

                        // Lier le message assistant à son appel LLM (callId)
                        $this->conversationManager->saveMessage($conversation, MessageRole::MODEL, $result['answer'], $metadata, $callId);
                    }
                }

                // Add conversation_id to result
                if ($conversation) {
                    $result['conversation_id'] = $conversation->getId();
                }

                // Send final result
                $sendEvent('result', $result);

                // Auto-generate title for new conversations (first exchange)
                if ($conversation && $this->conversationManager && !empty($message)) {
                    try {
                        $messages = $this->conversationManager->getMessages($conversation);

                        // Check if this is the first exchange (exactly 2 messages: 1 user + 1 model)
                        if (2 === count($messages)) {
                            $titlePrompt = "Génère un titre très court (max 6 mots) sans guillemets pour : '$message'";

                            // Generate title in stateless mode (don't pollute conversation history)
                            $titleResult = $this->chatService->ask($titlePrompt, ['stateless' => true, 'debug' => false]);

                            if (!empty($titleResult['answer'])) {
                                // Clean the result (remove quotes, etc.)
                                $rawTitle = $titleResult['answer'];
                                $newTitle = trim(str_replace(['"', 'Titre:', 'Title:'], '', $rawTitle));

                                if (!empty($newTitle)) {
                                    $this->conversationManager->updateTitle($conversation, $newTitle);

                                    // Send title update event to frontend
                                    $sendEvent('title', ['title' => $newTitle]);
                                }

                                // Track title generation cost (stateless call)
                                if ($this->tokenAccountingService !== null && !empty($titleResult['usage'])) {
                                    $titleUser = $this->getUser();
                                    $this->tokenAccountingService->logUsage(
                                        'chat',
                                        'title_generation',
                                        $titleResult['model'] ?? 'unknown',
                                        [
                                            'prompt_tokens'     => $titleResult['usage']['prompt_tokens'] ?? 0,
                                            'completion_tokens' => $titleResult['usage']['completion_tokens'] ?? 0,
                                            'thinking_tokens'   => $titleResult['usage']['thinking_tokens'] ?? 0,
                                        ],
                                        $titleUser instanceof ConversationOwnerInterface ? (string) $titleUser->getId() : null,
                                        $conversation->getId(),
                                        $titleResult['preset_id'] ?? null,
                                    );
                                }
                            }
                        }
                    } catch (\Throwable $e) {
                        // Silent fail: title generation is not critical
                        // Could log with a logger if available
                    }
                }
            } catch (\Throwable $e) {
                // Better error reporting for API failures
                $errorMessage = $e->getMessage();

                // Enrich error message for common failures
                if ($e instanceof LlmAuthenticationException) {
                    $errorMessage = "🔑 Erreur d'authentification : Les identifiants de l'IA sont incorrects ou expirés.";
                } elseif ($e instanceof LlmQuotaException) {
                    $errorMessage = "⚠️ Quota dépassé : La limite de consommation de l'IA a été atteinte.";
                } elseif ($e instanceof LlmRateLimitException) {
                    $errorMessage = "⏳ Trop de requêtes : Veuillez patienter un instant avant de réessayer.";
                } elseif ($e instanceof LlmServiceUnavailableException) {
                    $errorMessage = "🔧 Service indisponible : Le service IA est temporairement inaccessible.";
                } elseif ($e instanceof LlmException) {
                    $errorMessage = "🤖 Erreur IA : " . $e->getMessage();
                } elseif (str_contains($errorMessage, 'timeout') || str_contains($errorMessage, 'Timeout')) {
                    $errorMessage = "⏱️ Timeout : L'IA a mis trop de temps à répondre.";
                } else {
                    // En dev : afficher la vraie erreur + fichier:ligne pour cibler le coupable
                    if ($this->getParameter('kernel.debug')) {
                        $file = basename($e->getFile());
                        $errorMessage = sprintf('❌ %s (%s:%d)', $errorMessage, $file, $e->getLine());
                    } else {
                        $errorMessage = "❌ Erreur système : Une erreur inattendue est survenue.";
                    }
                }

                $sendEvent('error', $errorMessage);
            }
        });

        $response->headers->set('Content-Type', 'application/x-ndjson');
        $response->headers->set('X-Accel-Buffering', 'no'); // Disable Nginx buffering
        $response->headers->set('Cache-Control', 'no-cache');
        $response->headers->set('X-Debug-Token', 'disabled'); // Prevent Symfony debug toolbar injection

        return $response;
    }
}
