<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Tests\Unit\Controller\Api;

use ArnaudMoncondhuy\SynapseChat\Controller\Api\AttachmentController;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Service\AttachmentStorageService;
use ArnaudMoncondhuy\SynapseCore\Storage\Repository\SynapseMessageAttachmentRepository;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

class AttachmentControllerTest extends TestCase
{
    public function testControllerIsInstantiable(): void
    {
        $controller = new AttachmentController(
            $this->createStub(SynapseMessageAttachmentRepository::class),
            $this->createStub(AttachmentStorageService::class),
            $this->createStub(PermissionCheckerInterface::class),
            $this->createStub(EntityManagerInterface::class),
            'App\Entity\SynapseMessage',
        );

        $this->assertInstanceOf(AttachmentController::class, $controller);
    }
}
