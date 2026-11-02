# Pontes de Carreira 

Cruza as vagas com as evidências reais do seu perfil, mostra as lacunas e aprende, com os seus resultados, como adaptar o perfil ao mercado.

Acesso: `/` (login por senha definida em `PONTES_PASSWORD`). API: `/api/pontes/*`, todas autenticadas.

## O que aprende, e com quê

| Parte | Técnica | Aprende quando | Onde |
|---|---|---|---|
| Casamento requisito x evidência | TF-IDF (palavras e trigramas) + ajuste por par | você confirma ou rejeita uma sugestão | `src/pontes/ml/matcher.js` |
| Chance de avançar | Regressão logística online (SGD, L2), começa de pesos a priori | uma candidatura ganha desfecho | `src/pontes/ml/outcome.js` |
| Demanda do mercado | Contagem com meia-vida de 45 dias e tendência 30 dias x anterior | a cada consulta (vagas novas pesam mais) | `src/pontes/ml/market.js` |
| Prioridade das lacunas | demanda x impacto aprendido x esforço da ponte, com amostragem de Thompson para a "sugestão do dia" | junto com as anteriores | `src/pontes/ml/market.js` |

A IA (provedores definidos por variável de ambiente; ordem em `AI_PRIORITY`) só faz a extração dos requisitos da vaga e a carta. O restante roda localmente, sem custo por chamada.

### Desfecho que o modelo aprende
- Avançou (1): situação entrevista ou oferta, ou recusa em RH, técnica ou final.
- Não avançou (0): recusa na triagem; sem retorno após 30 dias (peso 0,5, rotina das 03:15).
- Sem desfecho: interesse, candidatado, descartada, recusa sem etapa informada.

As características da vaga são congeladas ao marcar "candidatado". Se um desfecho for corrigido depois, o modelo é reconstruído reproduzindo todos os desfechos em ordem.

### Como saber se está funcionando
A aba **Aprendizado** mostra a avaliação prequential: cada previsão é conferida antes de o modelo ver o resultado e comparada com a linha de base (taxa média até então). Menor erro que a base, de forma sustentada, indica aprendizado real.

## Meu perfil: currículo, LinkedIn e portfólios
Aba **Meu perfil** (`src/pontes/fontes.js`). Três fontes, cada uma com campo próprio:
1. **Currículo atual**: envie PDF, Word (.docx), .txt ou .md, ou cole o texto. O texto extraído aparece para você conferir antes de salvar. O PDF é lido no navegador (pdf.js, via cdnjs); os demais formatos, no servidor, sem dependências.
2. **LinkedIn**: o LinkedIn exige login e proíbe a leitura automática, então o endereço fica registrado e o conteúdo vem do **PDF do seu perfil** (Mais › Salvar como PDF) ou do texto colado.
3. **Portfólios**: um endereço por linha. GitHub é lido pela API pública (perfil, repositórios, README); sites comuns, como texto. Endereços internos e redirecionamentos para a rede local são bloqueados.

Botão **Extrair evidências com IA**: a IA lê as três fontes e propõe habilidades e entregas com a prova de cada uma (links só se constarem nas fontes; nível só se o texto sustentar). Você revisa, desmarca o que não quiser e só então entram em Evidências. Também pode preencher os campos vazios do currículo. As fontes entram nas análises de vaga e nas cartas como **contexto** (senioridade, adjacência), nunca como prova: requisito verde continua exigindo evidência aprovada.

## Currículo
Aba **Currículo**: preencha os dados uma vez (nome, contatos, resumo, experiência, formação) e baixe em Word (.docx), PDF (abre a página pronta para imprimir/salvar) ou Markdown. Nada é escrito por IA: entram só os seus dados e as evidências já conferidas (as marcadas "revisar" ficam de fora). Escolhendo uma vaga analisada, as evidências que provam os requisitos dela sobem na ordem. O .docx é gerado sem dependências externas (`src/pontes/curriculo.js`).

Formato de Experiência e Formação: primeira linha do bloco é o título (`Cargo — Empresa (período)`), as seguintes são itens; linha em branco separa os blocos.

## Radar diário (08:30, horário de Brasília)
`src/pontes/radar.js`. Busca em fontes públicas sem chave: **Gupy** (Brasil) e **Remotive** (remoto, em inglês). Descarta o que já foi visto (inclusive o que você apagou), anúncios antigos e títulos que você excluiu (estágio etc.), pontua cada anúncio contra as suas evidências (TF-IDF + habilidades suas citadas no anúncio, local e sem custo) e importa as melhores como "A avaliar" com a fonte `radar:*`. As primeiras N são analisadas pela IA, o que já mostra a chance estimada de avançar. Anúncios sem ao menos uma habilidade sua não entram.
- Configuração e botão **Buscar agora** na aba Radar. Cada fonte falha sozinha e o motivo aparece na tela.
- **Jobgether**: fonte própria, pelo feed que o site libera no robots.txt para uso por IA (`/astroapi/ai/jobs.json`, `src/pontes/jobgether.js`). Filtra pelas suas buscas, mantém só vagas abertas ao Brasil/LATAM/mundo e busca a descrição na página da vaga (até 8 por dia, respeitando o Crawl-delay). O robots.txt do site proíbe páginas de busca com `?`, então elas não são lidas.
- **Testar páginas**: o botão "Testar estas páginas" da aba Radar mostra, para cada endereço, as primeiras vagas encontradas ou o motivo exato (robots.txt, sem dados de vaga, HTTP 403…), sem importar nada.
- **Outros sites (BeBee…)**: cole, na aba Radar, o endereço da página de resultados já filtrada no próprio site (um por linha). O radar lê as vagas pelos dados estruturados `JobPosting` (JSON-LD) que os sites publicam para o Google (`src/pontes/paginas.js`), respeita o robots.txt, faz no máximo 1 página + 15 anúncios por site ao dia, com pausa. Não há leitor específico por site: se o site não publicar esses dados, exigir login ou bloquear robôs, o motivo aparece em "Última busca", por site. LinkedIn, Indeed e Glassdoor são recusados.
- LinkedIn e Indeed não entram: os termos de uso proíbem coleta automática.
- As vagas do radar alimentam também a demanda de mercado do aprendizado (viés para as suas buscas, de propósito).

## Limites honestos
- Com poucos desfechos (menos de 10) o modelo está em modo "premissas iniciais" e a chance estimada é só um palpite. A confiança sobe com os dados.
- Vagas de uma pessoa só são uma amostra pequena. O impacto por lacuna só aparece com pelo menos 2 observações e só merece confiança com bem mais.
- O casamento local nunca marca um requisito como provado sozinho: sugere, e você confirma.
- Os dados são de um único usuário (quem tem a senha).

## Dados
Tabelas `pontes_*` no SQLite local (`data/pontes.db`, ou o caminho em `PONTES_DB`): evidências, vagas, eventos (auditoria), modelo (pesos), previsões, ajustes e perfil. Faça backup copiando esse arquivo.

## Operação
- `npm run test:pontes` roda os testes (ML e ciclo completo com SQLite em memória e IA simulada).
- Reconstruir o modelo: botão na aba Aprendizado ou `POST /api/pontes/modelo/reconstruir`.
- Sem chave de IA configurada, a análise e a carta devolvem erro claro; o resto continua funcionando.
