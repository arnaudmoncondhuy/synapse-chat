<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Manager\ConversationManager;
use ArnaudMoncondhuy\SynapseCore\Storage\Entity\SynapseDebugLog;
use ArnaudMoncondhuy\SynapseCore\Storage\Repository\SynapseDebugLogRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Contracts\Translation\TranslatorInterface;

/**
 * API REST pour la gestion des conversations.
 */
#[Route('%synapse.chat_api_prefix%/conversations')]
class ConversationApiController extends AbstractController
{
    public function __construct(
        private readonly ConversationManager $conversationManager,
        private readonly ?TranslatorInterface $translator = null,
        private readonly ?SynapseDebugLogRepository $debugLogRepository = null,
    ) {
    }

    /**
     * Liste les conversations de l'utilisateur.
     */
    #[Route('', name: 'synapse_api_conversations_list', methods: ['GET'])]
    public function list(Request $request): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        $limit = max(1, min((int) $request->query->get('limit', 50), 500));
        $conversations = $this->conversationManager->getUserConversations($user, null, $limit);

        $data = array_map(fn ($conv) => [
            'id' => $conv->getId(),
            'title' => $conv->getTitle(),
            'created_at' => $conv->getCreatedAt()->format('c'),
            'updated_at' => $conv->getUpdatedAt()->format('c'),
            'status' => $conv->getStatus()->value,
            'message_count' => $conv->getMessageCount(),
        ], $conversations);

        return new JsonResponse($data);
    }

    /**
     * Supprime une conversation (soft delete).
     */
    #[Route('/{id}', name: 'synapse_api_conversations_delete', methods: ['DELETE'])]
    public function delete(string $id): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        try {
            $conversation = $this->conversationManager->getConversation($id, $user);
            if (!$conversation) {
                return new JsonResponse(['error' => 'SynapseConversation not found'], Response::HTTP_NOT_FOUND);
            }

            $this->conversationManager->deleteConversation($conversation);

            return new JsonResponse(['success' => true]);
        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], Response::HTTP_FORBIDDEN);
        }
    }

    /**
     * Renomme une conversation.
     */
    #[Route('/{id}/rename', name: 'synapse_api_conversations_rename', methods: ['PATCH'])]
    public function rename(string $id, Request $request): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        try {
            $data = json_decode($request->getContent() ?: '{}', true, 512, \JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            $data = [];
        }
        $titleRaw = $data['title'] ?? '';
        $title = is_string($titleRaw) ? mb_substr(trim($titleRaw), 0, 255) : '';

        if ('' === $title) {
            $msg = $this->translator ? $this->translator->trans('synapse.chat.api.error.title_required', [], 'synapse_chat') : 'Title is required';

            return new JsonResponse(['error' => $msg], Response::HTTP_BAD_REQUEST);
        }

        try {
            $conversation = $this->conversationManager->getConversation($id, $user);
            if (!$conversation) {
                return new JsonResponse(['error' => 'SynapseConversation not found'], Response::HTTP_NOT_FOUND);
            }

            $this->conversationManager->updateTitle($conversation, $title);

            return new JsonResponse([
                'success' => true,
                'title' => $title,
            ]);
        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], Response::HTTP_FORBIDDEN);
        }
    }

    /**
     * Récupère les messages d'une conversation.
     */
    #[Route('/{id}/messages', name: 'synapse_api_conversations_messages', methods: ['GET'])]
    public function messages(string $id): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        try {
            $conversation = $this->conversationManager->getConversation($id, $user);
            if (!$conversation) {
                return new JsonResponse(['error' => 'SynapseConversation not found'], Response::HTTP_NOT_FOUND);
            }

            $messages = $this->conversationManager->getMessages($conversation);

            $data = array_map(fn ($msg) => [
                'id' => $msg->getId(),
                'role' => $msg->getRole()->value,
                'content' => $msg->getDecryptedContent(),
                'decryptedContent' => $msg->getDecryptedContent(),
                'created_at' => $msg->getCreatedAt()->format('c'),
                'tokens' => $msg->getTotalTokens(),
            ], $messages);

            return new JsonResponse($data);
        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], Response::HTTP_FORBIDDEN);
        }
    }

    /**
     * Replay de la sidebar Transparence pour un message assistant passé.
     *
     * Reconstruit le payload de la sidebar à partir du SynapseDebugLog associé
     * au message (via metadata.debug_id) — pas de duplication d'information.
     * Disponible uniquement pour les messages dont l'appel LLM a été loggé en debug
     * (en pratique, les conversations enregistrées avec `debug_mode = true`).
     */
    #[Route('/{conversationId}/messages/{messageId}/transparency', name: 'synapse_api_message_transparency', methods: ['GET'])]
    public function messageTransparency(string $conversationId, string $messageId): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        if (null === $this->debugLogRepository) {
            return new JsonResponse(['error' => 'Debug log repository not available'], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        try {
            $conversation = $this->conversationManager->getConversation($conversationId, $user);
            if (!$conversation) {
                return new JsonResponse(['error' => 'Conversation not found'], Response::HTTP_NOT_FOUND);
            }

            // getMessages() déchiffre déjà metadata._encrypted vers ['debug_id' => ...]
            $messages = $this->conversationManager->getMessages($conversation);
            $message = null;
            foreach ($messages as $m) {
                if ($m->getId() === $messageId) {
                    $message = $m;
                    break;
                }
            }
            if (!$message) {
                return new JsonResponse(['error' => 'Message not found'], Response::HTTP_NOT_FOUND);
            }

            $meta = $message->getMetadata() ?? [];
            $debugId = is_string($meta['debug_id'] ?? null) ? $meta['debug_id'] : null;
            if (null === $debugId || '' === $debugId) {
                return new JsonResponse(['error' => 'No debug data available for this message'], Response::HTTP_NOT_FOUND);
            }

            $log = $this->debugLogRepository->findByDebugId($debugId);
            if (!$log) {
                return new JsonResponse(['error' => 'Debug log not found'], Response::HTTP_NOT_FOUND);
            }

            return new JsonResponse([
                'debugId' => $debugId,
                'events' => $this->buildTransparencyEvents($log),
            ]);
        } catch (\Exception $e) {
            return new JsonResponse(['error' => $e->getMessage()], Response::HTTP_FORBIDDEN);
        }
    }

    /**
     * Reconstruit la liste d'events de transparence à partir d'un SynapseDebugLog.
     *
     * Ne renvoie QUE les données affichées par la sidebar (rag, mémoire, thinking,
     * tool calls, code exec, usage). Les données sensibles (system_prompt,
     * raw_request_body, raw_api_response, history complet) ne sont jamais exposées.
     *
     * @return array<int, array{type: string, payload: mixed}>
     */
    private function buildTransparencyEvents(SynapseDebugLog $log): array
    {
        $data = $log->getData();
        $events = [];

        // 1. RAG sources consultées
        $promptMeta = is_array($data['prompt_metadata'] ?? null) ? $data['prompt_metadata'] : [];
        $ragMatching = is_array($promptMeta['rag_matching'] ?? null) ? $promptMeta['rag_matching'] : null;
        if (null !== $ragMatching && !empty($ragMatching['details']) && is_array($ragMatching['details'])) {
            $events[] = ['type' => 'rag_context', 'payload' => [
                'results' => array_values($ragMatching['details']),
                'totalInjected' => $ragMatching['relevant'] ?? count($ragMatching['details']),
                'tokenEstimate' => $ragMatching['token_estimate'] ?? 0,
            ]];
        }

        // 2. Mémoires rappelées
        $memMatching = is_array($promptMeta['memory_matching'] ?? null) ? $promptMeta['memory_matching'] : null;
        if (null !== $memMatching && !empty($memMatching['details']) && is_array($memMatching['details'])) {
            $events[] = ['type' => 'memory_recalled', 'payload' => [
                'memories' => array_values($memMatching['details']),
                'totalRecalled' => $memMatching['relevant'] ?? count($memMatching['details']),
            ]];
        }

        // 3. Turns : pour chaque tour, on push thinking + un marker turn_iteration au-delà du 1er
        $turns = is_array($data['turns'] ?? null) ? $data['turns'] : [];
        ksort($turns); // garder l'ordre numérique
        $turnList = array_values($turns);
        foreach ($turnList as $idx => $turn) {
            if (!is_array($turn)) {
                continue;
            }
            // Marker de tour pour les multi-turns (à partir du 2e)
            if ($idx >= 1) {
                $events[] = ['type' => 'turn_iteration', 'payload' => [
                    'turn' => $idx + 1,
                    'maxTurns' => count($turnList),
                    'tools' => [],
                    'usage' => is_array($turn['usage'] ?? null) ? $turn['usage'] : [],
                ]];
            }
            // Thinking : envoyé en un seul delta (le front concatène)
            $thinking = $turn['thinking'] ?? null;
            if (is_string($thinking) && '' !== $thinking) {
                $events[] = ['type' => 'thinking_delta', 'payload' => ['text' => $thinking]];
            }
        }

        // 4. Tool executions : on parcourt dans l'ordre et on émet started + completed pour chaque
        //    + un event code_execution dédié si tool_name === 'code_execute'
        $toolExecs = is_array($data['tool_executions'] ?? null) ? $data['tool_executions'] : [];
        foreach ($toolExecs as $exec) {
            if (!is_array($exec)) {
                continue;
            }
            $toolName = is_string($exec['tool_name'] ?? null) ? $exec['tool_name'] : '';
            $toolCallId = $exec['tool_call_id'] ?? null;
            $argsRaw = $exec['tool_args'] ?? '{}';
            $args = is_string($argsRaw) ? (json_decode($argsRaw, true) ?: []) : (is_array($argsRaw) ? $argsRaw : []);
            $resultRaw = $exec['tool_result'] ?? null;
            $resultDecoded = is_string($resultRaw) ? json_decode($resultRaw, true) : $resultRaw;

            $events[] = ['type' => 'tool_started', 'payload' => [
                'toolName' => $toolName,
                'toolLabel' => $toolName,
                'arguments' => $args,
                'toolCallId' => $toolCallId,
                'turn' => 1,
            ]];

            $resultPreview = is_string($resultRaw)
                ? mb_substr($resultRaw, 0, 200)
                : mb_substr((string) json_encode($resultRaw, JSON_UNESCAPED_UNICODE), 0, 200);
            $events[] = ['type' => 'tool_completed', 'payload' => [
                'toolName' => $toolName,
                'toolCallId' => $toolCallId,
                'resultPreview' => $resultPreview,
            ]];

            // Code Python : carte dédiée dans la sidebar
            if ('code_execute' === $toolName && is_array($resultDecoded)) {
                $events[] = ['type' => 'code_execution', 'payload' => [
                    'code' => is_string($args['code'] ?? null) ? $args['code'] : '',
                    'language' => is_string($args['language'] ?? null) ? $args['language'] : 'python',
                    'result' => $resultDecoded,
                ]];
            }
        }

        // 5. Footer usage / coût
        $usage = is_array($data['usage'] ?? null) ? $data['usage'] : [];
        if (!empty($usage)) {
            $events[] = ['type' => 'usage_update', 'payload' => [
                'model' => is_string($data['model'] ?? null) ? $data['model'] : null,
                'promptTokens' => $usage['prompt_tokens'] ?? 0,
                'completionTokens' => $usage['completion_tokens'] ?? 0,
                'thinkingTokens' => $usage['thinking_tokens'] ?? 0,
                'imageTokens' => $usage['image_completion_tokens'] ?? 0,
                'cost' => $data['estimated_cost'] ?? 0,
            ]];
        }

        return $events;
    }
}
