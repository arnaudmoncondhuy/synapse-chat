<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Controller\Api;

use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Service\AttachmentStorageService;
use ArnaudMoncondhuy\SynapseCore\Storage\Repository\SynapseMessageAttachmentRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
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
        private readonly EntityManagerInterface $em,
        #[Autowire('%synapse.persistence.message_class%')]
        private readonly string $messageClass,
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

        // Vérifier que l'utilisateur est propriétaire de la conversation liée
        /** @var class-string<\ArnaudMoncondhuy\SynapseCore\Storage\Entity\SynapseMessage> $messageClass */
        $messageClass = $this->messageClass;
        $message = $this->em->find($messageClass, $attachment->getMessageId());
        if (!$message || !$this->permissionChecker->canView($message->getConversation())) {
            throw $this->createAccessDeniedException();
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
