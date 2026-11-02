# Histórico do desenvolvimento — Pontes de Carreira

Registro das etapas, na ordem em que aconteceram (cada uma foi um Pull Request no repositório de origem, o assistente COD-ALL, que é privado), com o que deu errado e o que aprendi.

| PR | Entrega | Lição |
|---|---|---|
| #1 | Módulo Pontes: vagas, evidências, aderência, padrões, funil e ML online | Separar "IA sugere" de "eu aprovo" desde o desenho evita um perfil inflado. |
| #2 | Geração de currículo (.docx, HTML, Markdown) e radar diário às 08:30 | O .docx foi gerado com zip escrito à mão (crc32), sem dependência nova. |
| #3, #4 | Correção do endpoint da Gupy (404 duas vezes) | APIs não oficiais mudam; achei o endpoint atual e mantive os antigos como fallback. |
| #5 | Aba "Meu perfil": upload de currículo, leitura de LinkedIn (PDF/texto) e portfólios (GitHub); IA propõe evidências | LinkedIn não pode ser lido automaticamente (termos de uso); PDF/texto é o caminho legítimo. |
| #6 | Extração robusta: duas chamadas menores e reparo de JSON truncado | A IA devolvia JSON cortado e a tela dizia "não devolveu resultado legível". Dividir a tarefa e reparar o JSON resolveu. |
| #7 | Percentuais do radar coerentes | O banner mostrava 73/69/63% e a vaga aberta mostrava 76/39/75%. Eram métricas diferentes. Passei a mostrar a aderência real e a rotular a pré-triagem; incluí penalidade por bloqueio geográfico. |
| #8 | Leitura de outras páginas por `JobPosting` (JSON-LD), com `robots.txt` e proteção SSRF | Sem leitor específico por site: se o site não publica o padrão, a tela informa o motivo. |
| #9 | Respeito ao `Crawl-delay` | Boa conduta: o intervalo vem do próprio site. |
| #10 | Jobgether pelo feed liberado no `robots.txt` + botão "Testar páginas" | Na prática o feed trazia 10 vagas, nenhuma relevante; BeBee não publica `JobPosting`. Registrei o resultado em vez de forçar a fonte. |

## Decisões de engenharia

- **ML sem biblioteca**: o volume de dados é pequeno; um modelo simples, auditável e reproduzível (`reconstruir`) é mais honesto que um complexo.
- **Honestidade estatística**: avaliação prequential contra a taxa-base, e a interface diz "premissas iniciais" enquanto há menos de 10 desfechos.
- **Falha isolada**: cada fonte de vagas falha sozinha, com status por site.
- **Segurança**: proteção SSRF, `robots.txt`, recusa de sites que proíbem automação.
- **Testes**: 38 testes automatizados cobrindo ML, serviço, radar, robots.txt e fontes.

## O que ficou para depois

- Mais fontes (Adzuna com chave gratuita, feeds de vagas remotas).
- Mais dados de desfecho para o modelo sair do regime de premissas.
