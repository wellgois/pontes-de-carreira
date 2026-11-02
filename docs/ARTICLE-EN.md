# Building a career-transition agent where the AI is not allowed to prove anything

*Wellington Gois — data engineer. Code: [github.com/wellgois/pontes-de-carreira](https://github.com/wellgois/pontes-de-carreira)*

When you change fields, rejection emails say "not enough experience" without saying *which* experience. Generic AI résumé tools make this worse: they polish your profile and, in the process, invent skills you cannot defend in a technical interview.

I built **Pontes de Carreira** ("Career Bridges") to attack the problem from the other direction. It reads real job postings, compares them with evidence about *my* background, shows exactly where the gaps are, and learns from the outcome of each application. The one design rule that shaped everything: **the language model is never allowed to decide that I have a skill.**

## The evidence gate

Every job posting is parsed by an LLM into a list of requirements, each marked mandatory, desirable or noise ("dynamic team", "proactive attitude"). That is the only thing the model does with the posting, besides drafting a cover letter and *proposing* evidence from my résumé, LinkedIn export and GitHub.

A requirement turns green only when it is linked to an evidence item that **I approved**: a project, a link, a measurable result. A local matcher can suggest "probable" matches, but it can never turn anything green by itself. Résumé and LinkedIn text are used as context for the model, never as proof. The result is an adherence score I can defend line by line.

## Small data, simple models

I have a handful of applications, not millions. So instead of a heavy model I wrote the machine learning from scratch, with no ML library, in a few hundred lines:

- **TF-IDF over words and character trigrams** matches requirements to evidence, tolerating spelling and wording differences ("CI/CD" vs "continuous integration"). Confirming or rejecting a suggestion adjusts the similarity of that specific pair.
- **Online logistic regression** (SGD with L2 regularisation) estimates the chance that an application reaches an interview. It starts from a-priori weights and the interface says "initial assumptions" until 10 outcomes exist, so it never pretends to know more than it does.
- **Prequential evaluation** (test, then train) scores each prediction *before* the model sees the label, and compares the Brier score with a base-rate baseline. If the model is not beating "always predict the average", the app tells me.
- **Market demand with a 45-day half-life** makes recent postings weigh more when ranking which gaps are worth closing.
- **Thompson sampling** chooses which gap to study next, balancing exploring unproven bets and exploiting known payoffs.
- The model is **replayable**: it can be rebuilt deterministically from the event log, which makes it auditable.

## A daily radar that behaves

Every day at 08:30 a radar pulls postings from public sources, drops duplicates and internships, scores each posting against my evidence, and imports the best ones. It respects each site's `robots.txt` (most specific rule wins, `Crawl-delay` honoured), identifies itself, makes few requests, blocks internal network addresses, and refuses sites whose terms prohibit automated reading. LinkedIn, for example, is out; I use the PDF export of my own profile instead.

## What went wrong (the useful part)

- The radar banner showed 73%, 69% and 63% match, but opening each posting showed 76%, 39% and 75%. They were different metrics: a cheap local pre-screen versus the full AI analysis. The fix was not to hide the gap but to label both numbers and penalise postings restricted to residents of other countries.
- An unofficial job-board endpoint changed twice during development. Fallback endpoints and per-source status now keep one broken source from taking down the rest.
- The model sometimes returned truncated JSON. Splitting the work into two smaller calls and repairing the cut-off JSON solved it.

## Honest limits

With few outcomes, the learned model is an estimate, not a promise. The local pre-screening cannot see visa or residency rules. And the whole thing is a personal tool: single user, password login, SQLite.

The project has 38 automated tests covering the ML, the service, the radar, `robots.txt` parsing and the source readers. If you work with data and are crossing into a new stack, the part I'd borrow is not the code but the rule: **let the machine propose, and make a human approve every claim.**
