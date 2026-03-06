<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\DependencyInjection;

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
        $viewsPath = \dirname(__DIR__) . '/Resources/views';

        $container->prependExtensionConfig('twig', [
            'paths' => [
                $viewsPath => 'Synapse',
            ],
        ]);

        // Enregistrement des assets chat dans AssetMapper.
        // Utilisation d'un chemin robuste remontant à la racine du bundle.
        $assetsDir = \dirname(__DIR__, 1) . '/../assets';
        if ($container->hasExtension('framework') && is_dir($assetsDir)) {
            $container->prependExtensionConfig('framework', [
                'asset_mapper' => [
                    'paths' => [
                        $assetsDir => 'synapse-chat',
                    ],
                ],
            ]);
        }
    }

    /**
     * Chargement principal de la configuration du bundle.
     */
    public function load(array $configs, ContainerBuilder $container): void
    {
        $configDir = \dirname(__DIR__, 1) . '/../config';
        $loader = new YamlFileLoader($container, new FileLocator($configDir));

        // Charger la config du chat (toujours, le fichier existe dans le bundle)
        if (is_file($configDir . '/chat.yaml')) {
            $loader->load('chat.yaml');
        }

        // Les contrôleurs API sont auto-découverts via les attributs Symfony
    }

    public function getAlias(): string
    {
        return 'synapse_chat';
    }
}
