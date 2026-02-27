<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Core\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Core\Manager\ConversationManager;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * API REST pour la gestion des conversations
 */
#[Route('/synapse/api/conversations')]
class ConversationApiController extends AbstractController
{
    public function __construct(
        private ConversationManager $conversationManager
    ) {
    }

    /**
     * Liste les conversations de l'utilisateur
     */
    #[Route('', name: 'synapse_api_conversations_list', methods: ['GET'])]
    public function list(Request $request): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        $limit = (int) $request->query->get('limit', 50);
        $conversations = $this->conversationManager->getUserConversations($user, null, $limit);

        $data = array_map(fn($conv) => [
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
     * Supprime une conversation (soft delete)
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
     * Renomme une conversation
     */
    #[Route('/{id}/rename', name: 'synapse_api_conversations_rename', methods: ['PATCH'])]
    public function rename(string $id, Request $request): JsonResponse
    {
        $user = $this->getUser();
        if (!$user instanceof ConversationOwnerInterface) {
            return new JsonResponse(['error' => 'User not authenticated'], Response::HTTP_UNAUTHORIZED);
        }

        $data = json_decode($request->getContent(), true);
        $title = $data['title'] ?? '';

        if (empty($title)) {
            return new JsonResponse(['error' => 'Title is required'], Response::HTTP_BAD_REQUEST);
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
     * Récupère les messages d'une conversation
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

            $data = array_map(fn($msg) => [
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
}
