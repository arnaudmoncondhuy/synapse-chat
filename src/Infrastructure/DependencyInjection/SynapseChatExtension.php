<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Infrastructure\DependencyInjection;

use Symfony\Component\Config\FileLocator;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Extension\Extension;
use Symfony\Component\DependencyInjection\Extension\PrependExtensionInterface;
use Symfony\Component\DependencyInjection\Loader\YamlFileLoader;

/**
 * Extension du bundle SynapseChat.
 *
 * Responsabilités :
 * 1. Enregistrer les chemins Twig pour le widget chat
 * 2. Configurer AssetMapper pour les assets chat (JS + CSS)
 * 3. Charger les contrôleurs API (ChatApiController, CsrfController, ResetController, ConversationApiController)
 */
class SynapseChatExtension extends Extension implements PrependExtensionInterface
{
    /**
     * Pré-configuration des autres bundles (Twig, AssetMapper).
     */
    public function prepend(ContainerBuilder $container): void
    {
        // Enregistrement du namespace Twig @Synapse
        $viewsPath = \dirname(__DIR__, 2) . '/Resources/views';
        if (!is_dir($viewsPath)) {
            // Fallback for vendor install
            $viewsPath = \dirname(__DIR__) . '/Resources/views';
        }

        $container->prependExtensionConfig('twig', [
            'paths' => [
                $viewsPath => 'Synapse',
            ],
        ]);

        // Enregistrement des assets pour AssetMapper
        $assetsPath = \dirname(__DIR__, 3) . '/assets';
        $container->prependExtensionConfig('framework', [
            'asset_mapper' => [
                'paths' => [
                    $assetsPath => 'synapse-chat',
                ],
            ],
        ]);
    }

    /**
     * Chargement principal de la configuration du bundle.
     */
    public function load(array $configs, ContainerBuilder $container): void
    {
        $loader = new YamlFileLoader($container, new FileLocator(\dirname(__DIR__, 2) . '/../../config'));

        // Charger la config du chat si elle existe
        $chatConfigFile = \dirname(__DIR__, 2) . '/../../config/chat.yaml';
        if (is_file($chatConfigFile)) {
            $loader->load('chat.yaml');
        }

        // Les contrôleurs API seront auto-découverts par les attributs Symfony
    }

    public function getAlias(): string
    {
        return 'synapse_chat';
    }
}
