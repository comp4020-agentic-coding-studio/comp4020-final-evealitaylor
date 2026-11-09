# COMP8020 Research Note

## Beyond Autonomy: Why Good Agentic Practice Requires Human-Owned Scope

Discussion of AI in software development has moved fast, from tab completion in IDEs, to chat model copy-paste, and now agents that take an issue, find a solution and work through it unchaperoned. Accompanying this shift is the question of whether more autonomy on the part of AI is better. My argument is that when it comes to scope and intent decision-making, the human's role is far more important, as ultimately humans are the ones being subjected to what gets created, either positively or negatively. Good agentic practice allows the agent to run as an execution engine that brings to life those human design decisions, and builds a harness that allows the human to switch from policing and correction, to driving the vision and giving more time for ideation and good prompt generation.

While the big debate on AI's role in development is ongoing and there is a definite push-pull in media and popular culture about where the direction of AI is going and what that means for humanity, the industry seems firmly planted in the "let AI do it all" camp. Recent restructures and mass-redundancies at Atlassian and Canva this year highlight this shift, as organisations view investment in AI as more critical than the past and ongoing investment of their human workforces. However, some people and organisations are pushing back, and not just due to security and data concerns. Abandoning AI due to catastrophic errors and falsification is an emerging trend, often prompted by a lack of knowledge in how to effectively direct an AI tool (Telford, 2026).

AI-building companies have noticed and have been proactively trying to avoid these issues. Anthropic’s Claude Code guidance recommends exploring and planning before any code is written (Anthropic, 2026), with the human approving the plan, and its guide to building agents describes pausing for human feedback at checkpoints (Anthropic, 2024). Anthropics own words point to how these tools were built, and what the human intent was behind them. If these tools were built to rely on human guidance and feedback, then this is precisely how we should be using them.

The strongest argument for fully embracing AI is speed and efficiency, particularly in our productivity-focused capitalist society. Peng et al. (2023) found developers using Copilot finished a task substantially faster, however context is essential when evaluating AI's success. Peng’s participants built a greenfield project in a controlled setting, meanwhile Kinniment et al.'s randomised trial (2024) put experienced developers on mature repositories they knew well, and they were measured to be slower with AI while actually believing they were faster. Speediness seems to depend on how well specified the task is and how much context and knowledge the developer already holds, which is what a harness supplies. Perception matters too, as a team judging by feel how fast they've been may not realise the true outcome and bias may cause them to err in their judgement. I liken this to feeling like I commuted home faster on a longer route with no traffic, as opposed to it taking the same amount of time or less on a congested road with stop-start driving.

That cost is there either way, but it does matter when and where the choice is made. Pearce et al. (2022) found a large share of Copilot suggestions in security-relevant scenarios were vulnerable, and Perry et al. (2023) found participants with an assistant wrote less secure code while being more confident in it. A well-specified bug in an established code-base with a reliable test suite is a good candidate for autonomy, because intent is already encoded and the human-level decision making has already occurred.

I believe that the debate is not that agents can't work in autonomy, but what, how and when we trust agents to build. Our brains want to tell us that AI is just like us, it reads us well and sounds like us, and we are primally and inherently primed to trust something like that, its how we evolved and how we learn to exist from infancy. However we need to be able to trust our own instincts, our own knowledge and experience and tap into to the very real relationship we have with people and the world around us.

## References

**Anthropic.** (2026). *Best Practices for Claude Code*. <https://code.claude.com/docs/en/best-practices>

**Anthropic.** (2024). *Building Effective Agents*. <https://www.anthropic.com/research/building-effective-agents>

**Atlassian.** (2026). Atlassian team update: March 2026. <https://www.atlassian.com/blog/company-news/atlassian-team-update-march-2026>

**Becker, J. et al.** (2025). Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity. <https://arxiv.org/abs/2507.09089>

**Canva.** (2026). An important update on our team. <https://www.canva.com/newsroom/news/canva-team-update/>

**Pearce, H. et al.** (2022). Asleep at the Keyboard? Assessing the Security of GitHub Copilot's Code Contributions. *2022 IEEE Symposium on Security and Privacy (SP)*. <https://arxiv.org/abs/2108.09293>

**Peng, S. et al.** (2023). The Impact of AI on Developer Productivity: Evidence from GitHub Copilot. <https://arxiv.org/pdf/2302.06590>

**Perry, N. et al.** (2023). Do Users Write More Insecure Code with AI Assistants? *Proceedings of the 2023 ACM SIGSAC Conference on Computer and Communications Security (CCS '23)*. <https://arxiv.org/pdf/2211.03622>

**Telford, T.** (2026, October 13). Companies rushed in on AI. Now some are pulling back. The Guardian. <https://www.theguardian.com/technology/2026/oct/13/ai-companies-rushed-workers-fallout>