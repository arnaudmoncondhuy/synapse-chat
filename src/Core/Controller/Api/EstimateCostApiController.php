<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Core\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Core\Accounting\TokenCostEstimator;
use ArnaudMoncondhuy\SynapseCore\Core\Manager\ConversationManager;
use ArnaudMoncondhuy\SynapseCore\Core\Formatter\MessageFormatter;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * API d'estimation du coût d'une requête avant envoi.
 */
#[Route('/synapse/api')]
class EstimateCostApiController extends AbstractController
{
    public function __construct(
        private TokenCostEstimator $costEstimator,
        private PermissionCheckerInterface $permissionChecker,
        private ?ConversationManager $conversationManager = null,
        private ?MessageFormatter $messageFormatter = null,
    ) {}

    #[Route('/estimate-cost', name: 'synapse_api_estimate_cost', methods: ['POST'])]
    public function estimateCost(Request $request): JsonResponse
    {
        if (!$this->permissionChecker->canCreateConversation()) {
            return $this->json(['error' => 'Access denied.'], 403);
        }

        $data = json_decode($request->getContent(), true) ?? [];
        $message = trim((string) ($data['message'] ?? ''));
        $conversationId = $data['conversation_id'] ?? null;

        $contents = [];

        if ($conversationId && $this->conversationManager && $this->messageFormatter) {
            $user = $this->getUser();
            if ($user instanceof ConversationOwnerInterface) {
                $conversation = $this->conversationManager->getConversation($conversationId, $user);
                if ($conversation !== null) {
                    $dbMessages = $this->conversationManager->getMessages($conversation);
                    $contents = $this->messageFormatter->entitiesToApiFormat($dbMessages);
                }
            }
        }

        if ($message !== '') {
            $contents[] = ['role' => 'user', 'content' => $message];
        }

        if (empty($contents)) {
            return $this->json([
                'prompt_tokens' => 0,
                'estimated_output_tokens' => 2048,
                'cost_model_currency' => 0.0,
                'cost_reference' => 0.0,
                'currency' => 'USD',
            ]);
        }

        $estimate = $this->costEstimator->estimateCost($contents);

        return $this->json($estimate);
    }
}
