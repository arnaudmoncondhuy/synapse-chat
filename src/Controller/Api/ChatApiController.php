<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Engine\ChatService;
use ArnaudMoncondhuy\SynapseCore\Event\SynapseStatusChangedEvent;
use ArnaudMoncondhuy\SynapseCore\Event\SynapseTokenStreamedEvent;
use ArnaudMoncondhuy\SynapseCore\Event\SynapseToolCallCompletedEvent;
use ArnaudMoncondhuy\SynapseCore\Formatter\MessageFormatter;
use ArnaudMoncondhuy\SynapseCore\Manager\ConversationManager;
use ArnaudMoncondhuy\SynapseCore\Shared\Enum\MessageRole;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmAuthenticationException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmQuotaException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmRateLimitException;
use ArnaudMoncondhuy\SynapseCore\Shared\Exception\LlmServiceUnavailableException;
use ArnaudMoncondhuy\SynapseCore\Shared\Model\TokenUsage;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Profiler\Profiler;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;
use Symfony\Contracts\Translation\TranslatorInterface;

/**
 * Contrôleur API principal pour le flux de conversation.
 *
 * Ce contrôleur expose le endpoint `%synapse.chat_api_prefix%/chat` qui gère les échanges
 * en temps réel avec le frontend via un flux NDJSON (Streamed Response).
 */
#[Route('%synapse.chat_api_prefix%')]
class ChatApiController extends AbstractController
{
    public function __construct(
        private readonly ChatService $chatService,
        private readonly EventDispatcherInterface $dispatcher,
        private readonly PermissionCheckerInterface $permissionChecker,
        private readonly ?ConversationManager $conversationManager = null,
        private readonly ?MessageFormatter $messageFormatter = null,
        private readonly ?CsrfTokenManagerInterface $csrfTokenManager = null,
        private readonly ?\ArnaudMoncondhuy\SynapseCore\Accounting\TokenAccountingService $tokenAccountingService = null,
        private readonly ?\ArnaudMoncondhuy\SynapseCore\Accounting\TokenCostEstimator $tokenCostEstimator = null,
        private readonly ?TranslatorInterface $translator = null,
    ) {
    }

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
     * @param Request $request la requête HTTP contenant le message JSON
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
            if ('' === $token) {
                $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.csrf_missing', [], 'synapse_chat') : 'Jeton CSRF manquant.';
                throw $this->createAccessDeniedException($msg);
            }
            if (!$this->isCsrfTokenValid('synapse_api', $token)) {
                $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.csrf_invalid', [], 'synapse_chat') : 'Jeton CSRF invalide ou expiré.';
                throw $this->createAccessDeniedException($msg);
            }
        }

        // Permission check: Can start/continue chat?
        if (!$this->permissionChecker->canCreateConversation()) {
            $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.permission_denied', [], 'synapse_chat') : 'Not allowed to start a conversation.';
            throw $this->createAccessDeniedException($msg);
        }

        // 1. On désactive le profiler pour ne pas casser le flux JSON
        if ($profiler) {
            $profiler->disable();
        }

        $rawJson = $request->getContent();
        $decoded = json_decode(is_string($rawJson) ? $rawJson : '{}', true);
        $data = is_array($decoded) ? $decoded : [];

        $messageRaw = $data['message'] ?? '';
        $message = is_string($messageRaw) ? $messageRaw : '';

        // Vision: images optionnelles [['mime_type' => 'image/jpeg', 'data' => 'base64...']]
        $imagesRaw = $data['images'] ?? [];
        $images = is_array($imagesRaw)
            ? array_values(array_filter($imagesRaw, fn ($i) => is_array($i) && isset($i['data'], $i['mime_type']) && is_string($i['data']) && is_string($i['mime_type'])))
            : [];

        $optionsRaw = $data['options'] ?? [];
        $options = is_array($optionsRaw) ? $optionsRaw : [];

        $debugRaw = $data['debug'] ?? ($options['debug'] ?? false);
        $options['debug'] = (bool) $debugRaw;

        $conversationIdRaw = $data['conversation_id'] ?? null;
        $conversationId = is_string($conversationIdRaw) ? $conversationIdRaw : null;
        $options['conversation_id'] = $conversationId;  // Pass to ChatService for debug logging

        // Load conversation if ID provided and persistence enabled
        $conversation = null;
        if ($conversationId && $this->conversationManager) {
            $user = $this->getUser();
            if ($user instanceof ConversationOwnerInterface) {
                $conversation = $this->conversationManager->getConversation($conversationId, $user);
                if ($conversation) {
                    if (!$this->permissionChecker->canView($conversation)) {
                        $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.conversation_access_denied', [], 'synapse_chat') : 'Access Denied to this conversation.';
                        throw $this->createAccessDeniedException($msg);
                    }
                    $this->conversationManager->setCurrentConversation($conversation);
                }
            }
        }

        $response = new StreamedResponse(function () use ($message, $options, $conversation, $conversationId, $images) {
            // CRITICAL: Disable ALL output buffering to prevent Symfony Debug Toolbar injection
            // The toolbar tries to inject HTML into buffered output, corrupting NDJSON stream
            while (ob_get_level() > 0) {
                ob_end_clean();
            }
            ob_implicit_flush(true);

            // Helper to send NDJSON event
            $sendEvent = function (string $type, mixed $payload): void {
                echo json_encode(['type' => $type, 'payload' => $payload], JSON_INVALID_UTF8_IGNORE | JSON_THROW_ON_ERROR)."\n";
                // Force flush explicitly
                if (ob_get_length() > 0) {
                    ob_flush();
                }
                flush();
            };

            // Send padding to bypass browser/proxy buffering (approx 2KB)
            echo ':'.str_repeat(' ', 2048)."\n";
            flush();

            $isReset = isset($options['reset_conversation']) && true === $options['reset_conversation'];
            if (empty($message) && !$isReset) {
                $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.message_required', [], 'synapse_chat') : 'SynapseMessage is required.';
                $sendEvent('error', $msg);

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
                        $trailingImages = $this->messageFormatter->getAndClearTrailingImages();
                        if (!empty($trailingImages)) {
                            $options['_trailing_generated_images'] = $trailingImages;
                        }
                    } else {
                        // Fallback (legacy risks sending encrypted content)
                        $history = [];
                        foreach ($dbMessages as $dbMsg) {
                            $history[] = [
                                'role' => $dbMsg->getRole(),
                                'content' => $dbMsg->getContent(),
                            ];
                        }
                        $options['history'] = $history;
                    }
                }

                // Temporary event listeners for NDJSON streaming (scoped to this request)
                $statusListener = function (SynapseStatusChangedEvent $e) use ($sendEvent): void {
                    $sendEvent('status', ['message' => $e->message, 'step' => $e->step]);
                };
                $tokenListener = function (SynapseTokenStreamedEvent $e) use ($sendEvent): void {
                    $sendEvent('delta', ['text' => $e->token]);
                };
                $toolListener = function (SynapseToolCallCompletedEvent $e) use ($sendEvent, $conversation): void {
                    $isProposeToRemember = 'propose_to_remember' === $e->getToolName() || str_ends_with($e->getToolName(), 'propose_to_remember');
                    if ($isProposeToRemember && \is_array($e->getResult()) && ($e->getResult()['__synapse_action'] ?? '') === 'memory_proposal') {
                        $sendEvent('tool_executed', [
                            'tool' => 'propose_to_remember',
                            'proposal' => $e->getResult(),
                            'conversation_id' => $conversation?->getId(),
                        ]);
                    }
                };
                $this->dispatcher->addListener(SynapseStatusChangedEvent::class, $statusListener);
                $this->dispatcher->addListener(SynapseTokenStreamedEvent::class, $tokenListener);
                $this->dispatcher->addListener(SynapseToolCallCompletedEvent::class, $toolListener);

                // Pass user_id for spending limit checks
                $user = $this->getUser();
                if ($user instanceof ConversationOwnerInterface) {
                    $options['user_id'] = (string) $user->getId();
                }

                // Estimate cost for spending limit check (before LLM call)
                if (null !== $this->tokenCostEstimator) {
                    $historyRaw = $options['history'] ?? [];
                    /** @var array<int, array{role: string, content?: string|null}> $estimateContents */
                    $estimateContents = is_array($historyRaw) ? $historyRaw : [];

                    if ('' !== $message) {
                        $estimateContents[] = ['role' => 'user', 'content' => $message];
                    }
                    if (!empty($estimateContents)) {
                        $estimate = $this->tokenCostEstimator->estimateCost($estimateContents);
                        $options['estimated_cost_reference'] = (float) $estimate['cost_reference'];
                    }
                }

                // Build typed options array for ChatService::ask
                /** @var array{tone?: string, history?: array<int, array<string, mixed>>, stateless?: bool, debug?: bool, preset?: \ArnaudMoncondhuy\SynapseCore\Storage\Entity\SynapseModelPreset, conversation_id?: string, user_id?: string, estimated_cost_reference?: float, streaming?: bool, reset_conversation?: bool} $typedOptions */
                $typedOptions = [];
                if (isset($options['tone']) && is_string($options['tone'])) {
                    $typedOptions['tone'] = $options['tone'];
                }
                if (isset($options['agent']) && is_string($options['agent']) && '' !== $options['agent']) {
                    $typedOptions['agent'] = $options['agent'];
                }
                if (isset($options['history']) && is_array($options['history'])) {
                    /** @var array<int, array<string, mixed>> $history */
                    $history = $options['history'];
                    $typedOptions['history'] = $history;
                }
                if (isset($options['stateless'])) {
                    $typedOptions['stateless'] = (bool) $options['stateless'];
                }
                $typedOptions['debug'] = (bool) $options['debug'];
                if (null !== $conversationId) {
                    $typedOptions['conversation_id'] = $conversationId;
                }
                if (isset($options['user_id']) && is_string($options['user_id'])) {
                    $typedOptions['user_id'] = $options['user_id'];
                }
                if (isset($options['estimated_cost_reference']) && is_numeric($options['estimated_cost_reference'])) {
                    $typedOptions['estimated_cost_reference'] = (float) $options['estimated_cost_reference'];
                }
                if (isset($options['streaming'])) {
                    $typedOptions['streaming'] = (bool) $options['streaming'];
                }
                if (isset($options['reset_conversation'])) {
                    $typedOptions['reset_conversation'] = (bool) $options['reset_conversation'];
                }
                if (isset($options['_trailing_generated_images']) && is_array($options['_trailing_generated_images'])) {
                    $typedOptions['_trailing_generated_images'] = $options['_trailing_generated_images'];
                }

                // Execute chat (ChatService dispatche les events SynapseTokenStreamedEvent, etc.)
                try {
                    $result = $this->chatService->ask($message, $typedOptions, $images);
                } finally {
                    $this->dispatcher->removeListener(SynapseStatusChangedEvent::class, $statusListener);
                    $this->dispatcher->removeListener(SynapseTokenStreamedEvent::class, $tokenListener);
                    $this->dispatcher->removeListener(SynapseToolCallCompletedEvent::class, $toolListener);
                }

                // Save BOTH user message and assistant response to database after processing
                if ($conversation && $this->conversationManager) {
                    // Save user message (pas d'appel LLM associé)
                    if ('' !== $message || !empty($images)) {
                        $this->conversationManager->saveMessage($conversation, MessageRole::USER, $message ?: '[image]', [], null, $images);
                    }

                    $hasGeneratedImages = !empty($result['generated_images']);
                    // Quand des images sont générées, supprimer les artefacts de formatage purs
                    // (ex: "```" retourné par certains modèles en multi-tour).
                    // Le texte légitime accompagnant une image est préservé.
                    if ($hasGeneratedImages && '' !== ($result['answer'] ?? '')) {
                        $stripped = trim(str_replace(['`', "\n", "\r"], '', (string) $result['answer']));
                        if ('' === $stripped) {
                            $result['answer'] = '';
                        }
                    }
                    if (!empty($result['answer']) || $hasGeneratedImages) {
                        $usage = $result['usage'] ?? [];
                        $safetyRatings = [];
                        foreach ($result['safety'] ?? [] as $rating) {
                            if (
                                isset($rating['category'], $rating['probability'])
                                && is_string($rating['category'])
                                && is_string($rating['probability'])
                            ) {
                                /** @var array{category: string, probability: string} $typedRating */
                                $typedRating = ['category' => $rating['category'], 'probability' => $rating['probability']];
                                $safetyRatings[$rating['category']] = $typedRating;
                            }
                        }

                        $metadata = [
                            'prompt_tokens' => $usage['prompt_tokens'] ?? 0,
                            'completion_tokens' => $usage['completion_tokens'] ?? 0,
                            'thinking_tokens' => $usage['thinking_tokens'] ?? 0,
                            'safety_ratings' => $safetyRatings,
                            'model' => $result['model'] ?? null,
                            'preset_id' => $result['preset_id'] ?? null,
                            'metadata' => ['debug_id' => $result['debug_id'] ?? null],
                        ];

                        // Log l'appel LLM dans synapse_llm_call et récupérer le callId
                        $callId = null;
                        if (null !== $this->tokenAccountingService) {
                            $llmCall = $this->tokenAccountingService->logUsage(
                                'chat',
                                'chat_turn',
                                $result['model'] ?? 'unknown',
                                TokenUsage::fromArray($result['usage'] ?? []),
                                $user instanceof ConversationOwnerInterface ? (string) $user->getId() : null,
                                $conversation->getId(),
                                $result['preset_id'] ?? null,
                                $result['agent_id'] ?? null
                            );
                            $callId = $llmCall->getCallId();
                        }

                        // Lier le message assistant à son appel LLM (callId)
                        /** @var list<array{mime_type: string, data: string}> $generatedImages */
                        $generatedImages = is_array($result['generated_images'] ?? null) ? $result['generated_images'] : [];
                        $answerText = ('' !== $result['answer']) ? $result['answer'] : ($hasGeneratedImages ? '[image]' : '');
                        $modelMessage = $this->conversationManager->saveMessage($conversation, MessageRole::MODEL, $answerText, $metadata, $callId, $generatedImages);

                        // Inclure les UUIDs des images générées dans le résultat (pour affichage front)
                        if (!empty($generatedImages)) {
                            $savedAttachments = $this->conversationManager->getAttachmentsByMessageId($modelMessage->getId());
                            $result['generated_attachments'] = array_map(
                                fn ($att) => ['uuid' => $att->getId(), 'mime_type' => $att->getMimeType()],
                                $savedAttachments
                            );
                        }
                        unset($result['generated_images']);
                    }
                }

                // Add conversation_id to result
                if ($conversation) {
                    $result['conversation_id'] = $conversation->getId();
                }

                // Send final result
                $sendEvent('result', $result);

                // Auto-generate title for new conversations (first exchange)
                // Skip si le modèle n'a produit qu'une image (pas de texte à résumer)
                $hasTextAnswer = !empty($result['answer']) && '[image]' !== $result['answer'];
                if ($conversation && $this->conversationManager && !empty($message) && $hasTextAnswer) {
                    try {
                        $messages = $this->conversationManager->getMessages($conversation);

                        // Check if this is the first exchange (exactly 2 messages: 1 user + 1 model)
                        if (2 === count($messages)) {
                            $titlePrompt = $this->translator
                                ? $this->translator->trans('synapse.chat.api.title_generation_prompt', ['message' => $message], 'synapse_chat')
                                : "Génère un titre très court (max 6 mots) sans guillemets pour : '$message'";

                            // Generate title in stateless mode (don't pollute conversation history)
                            // Override system prompt to avoid preset instructions polluting the title
                            $titleResult = $this->chatService->ask($titlePrompt, ['stateless' => true, 'debug' => false, 'system_prompt' => 'You are a title generator. Respond with only the title, nothing else.']);

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
                                if (null !== $this->tokenAccountingService && !empty($titleResult['usage'])) {
                                    $titleUser = $this->getUser();
                                    $this->tokenAccountingService->logUsage(
                                        'chat',
                                        'title_generation',
                                        $titleResult['model'] ?? 'unknown',
                                        TokenUsage::fromArray($titleResult['usage']),
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
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.llm_auth', [], 'synapse_chat') : "🔑 Erreur d'authentification : Les identifiants de l'IA sont incorrects ou expirés.";
                } elseif ($e instanceof LlmQuotaException) {
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.llm_quota', [], 'synapse_chat') : "⚠️ Quota dépassé : La limite de consommation de l'IA a été atteinte.";
                } elseif ($e instanceof LlmRateLimitException) {
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.llm_rate_limit', [], 'synapse_chat') : '⏳ Trop de requêtes : Veuillez patienter un instant avant de réessayer.';
                } elseif ($e instanceof LlmServiceUnavailableException) {
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.llm_unavailable', [], 'synapse_chat') : '🔧 Service indisponible : Le service IA est temporairement inaccessible.';
                } elseif ($e instanceof LlmException) {
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.llm_generic', ['error' => $e->getMessage()], 'synapse_chat') : '🤖 Erreur IA : '.$e->getMessage();
                } elseif (str_contains((string) $errorMessage, 'timeout') || str_contains((string) $errorMessage, 'Timeout')) {
                    $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.timeout', [], 'synapse_chat') : "⏱️ Timeout : L'IA a mis trop de temps à répondre.";
                } else {
                    // En dev : afficher la vraie erreur + fichier:ligne pour cibler le coupable
                    if ($this->getParameter('kernel.debug')) {
                        $file = basename($e->getFile());
                        $errorMessage = sprintf('❌ %s (%s:%d)', $errorMessage, $file, $e->getLine());
                    } else {
                        $errorMessage = $this->translator ? $this->translator->trans('synapse.chat.api.error.system', [], 'synapse_chat') : '❌ Erreur système : Une erreur inattendue est survenue.';
                    }
                }

                $sendEvent('error', (string) $errorMessage);
            }
        });

        $response->headers->set('Content-Type', 'application/x-ndjson');
        $response->headers->set('X-Accel-Buffering', 'no'); // Disable Nginx buffering
        $response->headers->set('Cache-Control', 'no-cache');
        $response->headers->set('X-Debug-Token', 'disabled'); // Prevent Symfony debug toolbar injection

        return $response;
    }
}
