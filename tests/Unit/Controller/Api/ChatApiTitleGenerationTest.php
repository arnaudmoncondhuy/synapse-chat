<?php

declare(strict_types=1);

namespace ArnaudMoncondhuy\SynapseChat\Tests\Unit\Controller\Api;

use ArnaudMoncondhuy\SynapseChat\Controller\Api\ChatApiController;
use ArnaudMoncondhuy\SynapseCore\Agent\AgentResolver;
use ArnaudMoncondhuy\SynapseCore\AgentRegistry;
use ArnaudMoncondhuy\SynapseCore\Contract\ConversationOwnerInterface;
use ArnaudMoncondhuy\SynapseCore\Contract\PermissionCheckerInterface;
use ArnaudMoncondhuy\SynapseCore\Engine\ChatService;
use ArnaudMoncondhuy\SynapseCore\Manager\ConversationManager;
use ArnaudMoncondhuy\SynapseCore\Shared\Enum\MessageRole;
use ArnaudMoncondhuy\SynapseCore\Storage\Entity\SynapseConversation;
use ArnaudMoncondhuy\SynapseCore\Storage\Entity\SynapseMessage;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Security\Core\Authentication\Token\Storage\TokenStorageInterface;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Core\User\UserInterface;
use Symfony\Contracts\Translation\TranslatorInterface;

/**
 * Teste la génération automatique du titre lors du premier échange.
 *
 * Le titre est généré dans ChatApiController::chat() via un appel LLM secondaire
 * en mode stateless. Ces tests vérifient :
 * - le format ICU de la traduction (paramètre {message} et non %message%)
 * - le nettoyage du titre brut (guillemets, préfixes "Titre:", "Title:")
 * - les conditions de déclenchement (premier échange uniquement)
 * - la sauvegarde via ConversationManager::updateTitle()
 */
class ChatApiTitleGenerationTest extends TestCase
{
    private ChatService&MockObject $chatService;
    private EventDispatcherInterface&MockObject $dispatcher;
    private PermissionCheckerInterface $permissionChecker;
    private ConversationManager&MockObject $conversationManager;
    private TranslatorInterface&MockObject $translator;

    protected function setUp(): void
    {
        $this->chatService = $this->createMock(ChatService::class);
        $this->dispatcher = $this->createMock(EventDispatcherInterface::class);
        $this->permissionChecker = $this->createStub(PermissionCheckerInterface::class);
        $this->permissionChecker->method('canCreateConversation')->willReturn(true);
        $this->permissionChecker->method('canView')->willReturn(true);
        $this->conversationManager = $this->createMock(ConversationManager::class);
        $this->translator = $this->createMock(TranslatorInterface::class);
    }

    // -------------------------------------------------------------------------
    // Format ICU — le bug corrigé
    // -------------------------------------------------------------------------

    /**
     * Vérifie que la clé de traduction reçoit le paramètre au format ICU
     * (['message' => ...]) et non au format Symfony (['%message%' => ...]).
     *
     * BUG FIX: avant le correctif, le placeholder {message} n'était pas remplacé
     * car le code passait '%message%' au lieu de 'message'.
     */
    public function testTitlePromptUsesIcuParameterFormat(): void
    {
        $userMessage = 'quel est la capitale de Paris ?';

        $this->translator
            ->expects($this->atLeastOnce())
            ->method('trans')
            ->willReturnCallback(function (string $id, array $parameters, ?string $domain) use ($userMessage): string {
                if ('synapse.chat.api.title_generation_prompt' === $id) {
                    // Le paramètre DOIT être 'message' (ICU), PAS '%message%' (Symfony)
                    $this->assertArrayHasKey('message', $parameters, 'Le paramètre doit utiliser le format ICU {message}, pas %message%');
                    $this->assertArrayNotHasKey('%message%', $parameters, 'Le format Symfony %message% ne doit pas être utilisé avec ICU');
                    $this->assertSame($userMessage, $parameters['message']);
                    $this->assertSame('synapse_chat', $domain);

                    return "Génère un titre très court (max 6 mots) sans guillemets pour : '$userMessage'";  // ICU: '' = literal quote
                }

                return $id;
            });

        $this->executeChat($userMessage, 'Paris est une ville, pas un pays.');
    }

    // -------------------------------------------------------------------------
    // Nettoyage du titre
    // -------------------------------------------------------------------------

    #[DataProvider('titleCleaningProvider')]
    public function testTitleIsCleaned(string $rawTitle, string $expectedTitle): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        $this->conversationManager
            ->expects($this->once())
            ->method('updateTitle')
            ->with($this->isInstanceOf(SynapseConversation::class), $expectedTitle);

        $this->executeChat('Bonjour', 'Salut !', $rawTitle);
    }

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function titleCleaningProvider(): iterable
    {
        yield 'guillemets doubles' => ['"Capitale de Paris"', 'Capitale de Paris'];
        yield 'préfixe Titre:' => ['Titre: Capitale de Paris', 'Capitale de Paris'];
        yield 'préfixe Title:' => ['Title: Capitale de Paris', 'Capitale de Paris'];
        yield 'titre propre' => ['Capitale de Paris', 'Capitale de Paris'];
        yield 'guillemets + préfixe' => ['"Title: Test"', 'Test'];
        yield 'espaces autour' => ['  Bonjour le monde  ', 'Bonjour le monde'];
    }

    /**
     * Quand le LLM retourne un titre vide après nettoyage, updateTitle ne doit pas être appelé.
     */
    public function testEmptyTitleAfterCleaningIsIgnored(): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        $this->conversationManager
            ->expects($this->never())
            ->method('updateTitle');

        // Titre qui devient vide après nettoyage (que des guillemets)
        $this->executeChat('Bonjour', 'Salut !', '""');
    }

    // -------------------------------------------------------------------------
    // Conditions de déclenchement
    // -------------------------------------------------------------------------

    /**
     * Le titre n'est généré que lors du premier échange (exactement 2 messages).
     */
    public function testTitleNotGeneratedOnSubsequentExchanges(): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        // 4 messages = 2ème échange → pas de génération de titre
        $this->conversationManager
            ->expects($this->never())
            ->method('updateTitle');

        $this->executeChat('Et la France ?', 'La capitale est Paris.', null, 4);
    }

    /**
     * Le titre n'est pas généré si la réponse est une image seule.
     */
    public function testTitleNotGeneratedForImageOnlyResponse(): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        $this->conversationManager
            ->expects($this->never())
            ->method('updateTitle');

        $this->executeChat('Dessine un chat', '[image]');
    }

    /**
     * Le titre n'est pas généré si le message est vide.
     */
    public function testTitleNotGeneratedForEmptyMessage(): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        $this->conversationManager
            ->expects($this->never())
            ->method('updateTitle');

        $this->executeChat('', 'Réponse');
    }

    // -------------------------------------------------------------------------
    // Résilience
    // -------------------------------------------------------------------------

    /**
     * Une exception lors de la génération du titre ne doit PAS casser le flux principal.
     * Le chat doit retourner la réponse normalement.
     */
    public function testTitleGenerationFailureIsSilent(): void
    {
        $this->translator->method('trans')->willReturnArgument(0);

        // Le 2ème appel à ask() (title) lance une exception
        $this->chatService
            ->method('ask')
            ->willReturnCallback(function (string $message, array $options) {
                if ($options['stateless'] ?? false) {
                    throw new \RuntimeException('LLM timeout');
                }

                return [
                    'answer' => 'Réponse',
                    'usage' => [],
                    'safety' => [],
                    'model' => 'test',
                ];
            });

        // updateTitle ne doit pas être appelé (exception avant)
        $this->conversationManager
            ->expects($this->never())
            ->method('updateTitle');

        // Le test ne doit PAS lancer d'exception — le résultat principal doit arriver
        // (la vérification se fait via le mock : saveMessage appelé = réponse envoyée,
        //  updateTitle jamais appelé = exception silencieuse)
        $this->conversationManager
            ->expects($this->atLeastOnce())
            ->method('saveMessage');

        $this->executeChat('Bonjour', null);
    }

    // -------------------------------------------------------------------------
    // Helper — exécute le flux chat et capture la sortie NDJSON
    // -------------------------------------------------------------------------

    /**
     * Simule un appel au contrôleur ChatApiController::chat() et capture la sortie.
     *
     * @param string $userMessage Le message utilisateur
     * @param string|null $chatAnswer La réponse du LLM principal (null = configuré via chatService mock)
     * @param string|null $titleAnswer La réponse du LLM pour le titre (null = pas de mock spécifique)
     * @param int $messageCount Nombre de messages en DB (2 = premier échange)
     *
     * @return string La sortie NDJSON capturée
     */
    private function executeChat(
        string $userMessage,
        ?string $chatAnswer = 'Réponse test',
        ?string $titleAnswer = 'Titre Généré',
        int $messageCount = 2,
    ): string {
        // --- Conversation stub ---
        $conversation = $this->createStub(SynapseConversation::class);
        $conversation->method('getId')->willReturn('conv-123');

        // --- Messages en DB ---
        $messages = [];
        for ($i = 0; $i < $messageCount; ++$i) {
            $msg = $this->createStub(SynapseMessage::class);
            $msg->method('getRole')->willReturn(0 === $i % 2 ? MessageRole::USER : MessageRole::MODEL);
            $messages[] = $msg;
        }
        $this->conversationManager->method('getMessages')->willReturn($messages);

        // --- ConversationManager stubs ---
        $this->conversationManager->method('createConversation')->willReturn($conversation);
        $this->conversationManager->method('saveMessage')->willReturn($this->createStub(SynapseMessage::class));

        // --- ChatService::ask() ---
        if (null !== $chatAnswer) {
            $callIndex = 0;
            $this->chatService
                ->method('ask')
                ->willReturnCallback(function (string $msg, array $options) use ($chatAnswer, $titleAnswer, &$callIndex) {
                    ++$callIndex;
                    if (1 === $callIndex) {
                        return [
                            'answer' => $chatAnswer,
                            'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 20],
                            'safety' => [],
                            'model' => 'test-model',
                        ];
                    }

                    return [
                        'answer' => $titleAnswer,
                        'usage' => ['prompt_tokens' => 5, 'completion_tokens' => 5],
                        'safety' => [],
                        'model' => 'test-model',
                    ];
                });
        }

        // --- User stub (implements ConversationOwnerInterface + UserInterface) ---
        $user = new TestConversationOwner('user-1', 'user@test.com');

        $token = $this->createStub(TokenInterface::class);
        $token->method('getUser')->willReturn($user);

        $tokenStorage = $this->createStub(TokenStorageInterface::class);
        $tokenStorage->method('getToken')->willReturn($token);

        // --- Build controller with mocked container ---
        $controller = new ChatApiController(
            $this->chatService,
            $this->dispatcher,
            $this->permissionChecker,
            $this->createStub(AgentRegistry::class),
            $this->createStub(AgentResolver::class),
            $this->conversationManager,
            null,
            null,
            null,
            $this->translator,
        );

        $container = $this->createStub(ContainerInterface::class);
        $container->method('has')->willReturnCallback(fn (string $id) => match ($id) {
            'security.token_storage' => true,
            'parameter_bag' => true,
            default => false,
        });
        $container->method('get')->willReturnCallback(fn (string $id) => match ($id) {
            'security.token_storage' => $tokenStorage,
            'parameter_bag' => new TestParameterBag(),
            default => null,
        });

        $controller->setContainer($container);

        // --- Execute ---
        $request = new Request([], [], [], [], [], [], json_encode([
            'message' => $userMessage,
        ]));
        $request->headers->set('Content-Type', 'application/json');

        $response = $controller->chat($request, null);

        // Le contrôleur ferme TOUS les output buffers (while ob_get_level > 0)
        // pour éviter la pollution par le Symfony Debug Toolbar.
        // On capture via un output callback qui intercepte le contenu AVANT la fermeture.
        $captured = '';
        $priorLevel = ob_get_level();

        // Buffers sacrificiels avec callbacks qui capturent le contenu
        ob_start(function (string $chunk) use (&$captured): string {
            $captured .= $chunk;

            return '';
        });
        ob_start(); // Buffer superficiel que le contrôleur fermera en premier

        $response->sendContent();

        // Restaurer les buffers PHPUnit si le contrôleur les a fermés
        while (ob_get_level() < $priorLevel) {
            ob_start();
        }
        // Nettoyer les buffers restants au-dessus du niveau PHPUnit
        while (ob_get_level() > $priorLevel) {
            $captured .= ob_get_clean();
        }

        return $captured;
    }
}

/**
 * Concrete user stub implementing both interfaces.
 */
class TestConversationOwner implements ConversationOwnerInterface, UserInterface
{
    public function __construct(
        private readonly string $id,
        private readonly string $email,
    ) {
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getIdentifier(): string
    {
        return $this->id;
    }

    public function getRoles(): array
    {
        return ['ROLE_USER'];
    }

    public function getUserIdentifier(): string
    {
        return $this->email;
    }
}

/**
 * Minimal ParameterBag for controller tests.
 */
class TestParameterBag implements \Symfony\Component\DependencyInjection\ParameterBag\ParameterBagInterface
{
    public function get(string $name): \UnitEnum|array|string|int|float|bool|null
    {
        return match ($name) {
            'synapse.security.api_csrf_enabled' => false,
            'kernel.debug' => true,
            default => null,
        };
    }

    public function has(string $name): bool
    {
        return true;
    }

    public function all(): array
    {
        return [];
    }

    public function add(array $parameters): void
    {
    }

    public function set(string $name, mixed $value): void
    {
    }

    public function resolve(): void
    {
    }

    public function resolveValue(mixed $value): mixed
    {
        return $value;
    }

    public function escapeValue(mixed $value): mixed
    {
        return $value;
    }

    public function unescapeValue(mixed $value): mixed
    {
        return $value;
    }

    public function clear(): void
    {
    }

    public function remove(string $name): void
    {
    }
}
