<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Tests\Unit\Controller\Api;

use ArnaudMoncondhuy\SynapseChat\Controller\Api\ResetController;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Engine\ChatService;
use PHPUnit\Framework\TestCase;

class ResetControllerTest extends TestCase
{
    public function testControllerIsInstantiable(): void
    {
        $controller = new ResetController(
            $this->createStub(ChatService::class),
            $this->createStub(PermissionCheckerInterface::class),
        );

        $this->assertInstanceOf(ResetController::class, $controller);
    }
}
