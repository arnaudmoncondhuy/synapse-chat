<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat;

use ArnaudMoncondhuy\SynapseChat\Infrastructure\DependencyInjection\SynapseChatExtension;
use Symfony\Component\DependencyInjection\Extension\ExtensionInterface;
use Symfony\Component\HttpKernel\Bundle\Bundle;

/**
 * Classe principale du Bundle SynapseChat.
 *
 * Point d'entrée pour l'intégration dans le kernel Symfony.
 * Charge le widget de chat : API REST NDJSON, contrôleurs, templates Twig, assets JS/CSS.
 *
 * Dépend de : SynapseCoreBundle
 */
class SynapseChatBundle extends Bundle
{
    public function getContainerExtension(): ?ExtensionInterface
    {
        return new SynapseChatExtension();
    }

    public function getPath(): string
    {
        return \dirname(__DIR__);
    }
}
