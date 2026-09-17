# Roteiro de teste — reunião de arquitetura (quickstart V3)

Texto do spike M0 para ler em voz alta (ou tocar) durante uma gravação local. Serve para medir se
o agente ao vivo encontra os itens esperados, com a evidência certa, em até 3 minutos.

Como usar:

1. Cadastre uma reunião manual de 20 min com o título "Portal SES - Integração com a regulação"
   e clique em **Gravar agora**.
2. Leia as falas em ordem, com pausas curtas. Quem estiver sozinho pode ler as falas do
   "Remoto" tocando-as em outro aparelho, ou num vídeo/áudio no próprio computador (canal remoto).
3. Depois de ~3 min, confira o painel de itens e compare com a tabela de itens esperados.
4. Continue falando qualquer assunto até 15 min para ver o **Resumo corrente**.

## Falas

| # | Quem | Fala |
|---|---|---|
| 1 | Você (microfone) | Pessoal, o objetivo hoje é fechar a integração do Portal SES com o sistema de regulação. Hoje a gente faz chamada síncrona REST e, quando a regulação cai, o portal inteiro fica lento. |
| 2 | Remoto | Eu proponho a gente usar Kafka. Publica o evento de solicitação criada e a regulação consome no ritmo dela. |
| 3 | Remoto | Só que existe uma restrição de segurança: a regulação fica na rede interna e o Kafka precisaria de TLS mútuo. A infraestrutura ainda não tem certificado para isso. |
| 4 | Você | Então vamos decidir assim: fica decidido usar arquitetura orientada a eventos com Kafka para essa integração. O Marcos fica responsável por pedir os certificados para a infraestrutura até sexta-feira. |
| 5 | Remoto | Tem um risco de prazo aí, porque, se o certificado atrasar, a gente não entrega em outubro. |
| 6 | Remoto | E precisa garantir que nenhuma solicitação seja perdida. Requisito: toda mensagem tem que ter reprocessamento e fila de mensagens mortas. |
| 7 | Você | Também temos que medir: o tempo de resposta do portal não pode passar de dois segundos no percentil noventa e cinco. |
| 8 | Remoto | Ainda não sabemos se o Kafka vai ser gerenciado pela nuvem ou on-premise. Isso fica em aberto para a próxima reunião. |
| 9 | Remoto | Eu vou escrever os testes de contrato dos eventos até quarta que vem. |

## Itens esperados

| Tipo | Item | Fala | Detalhes |
|---|---|---|---|
| Decisão arquitetural | Arquitetura orientada a eventos com Kafka na integração | 4 | sistema: Portal SES / regulação |
| Pendência | Pedir os certificados para a infraestrutura | 4 | responsável: Marcos; prazo: sexta-feira |
| Pendência | Escrever os testes de contrato dos eventos | 9 | prazo: quarta que vem |
| Restrição | Kafka exige TLS mútuo na rede interna | 3 | — |
| Risco | Atraso do certificado compromete a entrega de outubro | 5 | categoria: prazo |
| Requisito não funcional | Reprocessamento e fila de mensagens mortas (nenhuma perda) | 6 | — |
| Requisito não funcional | Tempo de resposta ≤ 2 s no p95 | 7 | — |
| Pergunta em aberto | Kafka gerenciado na nuvem ou on-premise | 8 | — |
| Débito técnico (opcional) | Integração síncrona REST atual deixa o portal lento | 1 | — |

## Registro (SC-005)

Anote, para cada rodada:

- tempo até o primeiro item aparecer;
- itens esperados encontrados / 8 (o débito técnico é opcional);
- itens inventados ou duplicados;
- evidências que apontam para a fala errada;
- se o resumo corrente apareceu aos 15 min.

Registre o resultado em `docs/analise/agente-local.md` §15.
