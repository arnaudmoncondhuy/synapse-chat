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
        $viewsPath = \dirname(__DIR__) . '/Resources/views';
        if (!is_dir($viewsPath)) {
            // Fallback for vendor install or other structures
            $viewsPath = \dirname(__DIR__, 2) . '/Resources/views';
        }

        $container->prependExtensionConfig('twig', [
            'paths' => [
                $viewsPath => 'Synapse',
            ],
        ]);

        // Enregistrement des assets chat dans AssetMapper via le chemin vendor.
        // Fonctionne pour les deux contextes :
        // - Path repositories : vendor contient un symlink vers /synapse-bundle/...
        // - Packagist : vendor contient une copie complète
        // AssetMapper nécessite un chemin accessible au serveur HTTP (dans /app/...)
        if ($container->hasExtension('framework')) {
            $vendorAssetsDir = \dirname(__DIR__, 5) . '/vendor/arnaudmoncondhuy/synapse-chat/assets';
            if (is_dir($vendorAssetsDir)) {
                $container->prependExtensionConfig('framework', [
                    'asset_mapper' => [
                        'paths' => [
                            $vendorAssetsDir => 'synapse-chat',
                        ],
                    ],
                ]);
            }
        }
    }

    /**
     * Chargement principal de la configuration du bundle.
     */
    public function load(array $configs, ContainerBuilder $container): void
    {
        $configDir = \dirname(__DIR__, 3) . '/config';
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
