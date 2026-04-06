<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Tests\Unit\Controller\Api;

use ArnaudMoncondhuy\SynapseChat\Controller\Api\ConversationApiController;
use ArnaudMoncondhuy\SynapseCore\Manager\ConversationManager;
use PHPUnit\Framework\TestCase;

class ConversationApiControllerTest extends TestCase
{
    public function testControllerIsInstantiable(): void
    {
        $controller = new ConversationApiController(
            $this->createStub(ConversationManager::class),
        );

        $this->assertInstanceOf(ConversationApiController::class, $controller);
    }
}
