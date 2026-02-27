<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Core\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Csrf\CsrfTokenManagerInterface;

/**
 * Endpoint pour récupérer le jeton CSRF côté front (AJAX).
 * Évite de dépendre du HTML (meta / data-attribute) qui peut être absent si la page est surchargée ou en cache.
 */
#[Route('/synapse/api')]
class CsrfController extends AbstractController
{
    public function __construct(
        private PermissionCheckerInterface $permissionChecker,
        private ?CsrfTokenManagerInterface $csrfTokenManager = null,
    ) {}

    #[Route('/csrf-token', name: 'synapse_api_csrf_token', methods: ['GET'])]
    public function token(): JsonResponse
    {
        if (!$this->permissionChecker->canCreateConversation()) {
            return $this->json(['error' => 'Not allowed.'], 403);
        }
        if (!$this->csrfTokenManager) {
            return $this->json(['token' => '']);
        }
        $token = $this->csrfTokenManager->getToken('synapse_api')->getValue();
        return $this->json(['token' => $token]);
    }
}
