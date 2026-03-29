<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Service\AttachmentStorageService;
use ArnaudMoncondhuy\SynapseCore\Storage\Repository\SynapseMessageAttachmentRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/synapse/attachment/{uuid}', name: 'synapse_attachment_serve', methods: ['GET'])]
class AttachmentController extends AbstractController
{
    public function __construct(
        private readonly SynapseMessageAttachmentRepository $attachmentRepository,
        private readonly AttachmentStorageService $attachmentStorage,
        private readonly PermissionCheckerInterface $permissionChecker,
    ) {
    }

    public function __invoke(string $uuid): Response
    {
        if (!$this->permissionChecker->canCreateConversation()) {
            throw $this->createAccessDeniedException();
        }

        $attachment = $this->attachmentRepository->find($uuid);
        if (!$attachment) {
            throw $this->createNotFoundException();
        }

        $path = $this->attachmentStorage->getAbsolutePath($attachment);
        if (!file_exists($path)) {
            throw $this->createNotFoundException();
        }

        return new BinaryFileResponse($path, 200, [
            'Content-Type' => $attachment->getMimeType(),
            'Cache-Control' => 'private, max-age=86400',
        ]);
    }
}
