<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Controller\UI;

use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Manager\ConversationManager;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Profiler\Profiler;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Contrôleur UI de chat fourni par le bundle Chat.
 *
 * Expose la route `/synapse/chat` prête à l'emploi.
 * Le template peut être surchargé via `templates/bundles/SynapseChatBundle/chat/page.html.twig`.
 */
#[Route('%synapse.chat_ui_prefix%', name: 'synapse_chat', methods: ['GET'])]
class ChatUiController extends AbstractController
{
    public function __construct(
        private readonly PermissionCheckerInterface $permissionChecker,
        private readonly \ArnaudMoncondhuy\SynapseCore\Contract\ConfigProviderInterface $configProvider,
        private readonly ?ConversationManager $conversationManager = null,
    ) {
    }

    public function __invoke(Request $request, ?Profiler $profiler): Response
    {
        if (!$this->permissionChecker->canCreateConversation()) {
            throw $this->createAccessDeniedException('Access Denied to Chat UI.');
        }

        if ($profiler) {
            $profiler->disable();
        }

        $history = [];
        $currentConversationId = $request->query->get('conversation', '');
        $user = $this->getUser();
        $owner = $user instanceof \ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface ? $user : null;

        if (!empty($currentConversationId) && $this->conversationManager) {
            $conversation = $this->conversationManager->getConversation($currentConversationId, $owner);
            if ($conversation) {
                $history = $this->conversationManager->getHistoryArray($conversation, true);
            }
        }

        $config = $this->configProvider->getConfig();
        $debugMode = $config->debugMode;

        return $this->render('@Synapse/chat/page.html.twig', [
            'history' => $history,
            'currentConversationId' => $currentConversationId,
            'debug_mode' => $debugMode,
        ]);
    }
}
