<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Core\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Core\Chat\ChatService;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;

/**
 * Contrôleur utilitaire pour la gestion de session.
 */
#[Route('%synapse.chat_api_prefix%')]
class ResetController extends AbstractController
{
    public function __construct(
        private ChatService $chatService,
        private PermissionCheckerInterface $permissionChecker,
        private ?CsrfTokenManagerInterface $csrfTokenManager = null,
    ) {}

    /**
     * Réinitialise explicitement la conversation courante.
     *
     * Vide l'historique stocké en session.
     *
     * @return JsonResponse confirmation du reset
     */
    #[Route('/reset', name: 'synapse_api_reset', methods: ['POST'])]
    public function reset(Request $request): JsonResponse
    {
        if ($this->getParameter('synapse.security.api_csrf_enabled') && $this->csrfTokenManager) {
            $token = $request->headers->get('X-CSRF-Token') ?? $request->request->get('_csrf_token');
            if (!$this->isCsrfTokenValid('synapse_api', (string) $token)) {
                return $this->json(['error' => 'Invalid CSRF token.'], 403);
            }
        }

        if (!$this->permissionChecker->canCreateConversation()) {
            return $this->json(['error' => 'Not allowed.'], 403);
        }

        try {
            $this->chatService->resetConversation();

            return $this->json(['success' => true, 'message' => 'SynapseConversation reset.']);
        } catch (\Exception $e) {
            return $this->json(['error' => $e->getMessage()], 500);
        }
    }
}
