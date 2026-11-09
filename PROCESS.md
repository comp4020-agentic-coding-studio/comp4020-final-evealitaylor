# Process Overview

SeatSeeker is a multi-user, real-time desk availability tracker. I originally came up with the idea a few years ago and mocked up a UX version of it for my design portfolio (https://eve-taylor-portfolio.web.app/uxui/seatseeker). While I initially struggled to think of a concept based on the brief, I figured it was the perfect opportunity to see how far I could take the concept using Claude Code, since it perfectly fits the requirements for multi-user interactions, real-time data, and persistent state.

## Stack Justification

Because the course template gave us a pretty constrained environment, a tiny 256MB Fly.io machine and one data volume, keeping the tech stack as minimal as possible. I just used Node 24 built-ins and a vanilla JS frontend. No heavy frameworks. Since the infrastructure doesn't give us a separate database server, using node sqlite was the easiest and most practical way to make sure the activity log actually survived redeploys.

For the real-time requirement, I went with Server-Sent Events (SSE) instead of WebSockets. WebSockets felt like overkill since the real-time updates only need to flow one way—from the server to the browser—and the clients just use normal POST requests to do things. I also knew polling wouldn't survive the 60-viewer capstone showcase target. The only annoying trade-off with SSE was that idle connections would silently drop, which I noticed during testing. I had Claude fix it by adding a 15-second server ping to keep the connection alive ([`f9f61c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/f9f61c6)).

## Agentic workflow

I used Claude Code to write the actual implementation, and maintained heavy oversight on the harness. While I primarily had the vision and focused on design decision-making, some technical decisions were made by Claude independently which freed up space for further ideation.

## Scope Decisions

One back and forth decision I considered and ultimately went with were user accounts. I originally said no accounts necessary as I didn't want to overcomplicate, but as the app took shape it was obvious that nothing stopped one person claiming every desk, and the harness was updated in [`8aad560`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/8aad560). Claude asked me what data we should collect. I decided we needed names and student IDs, but I specifically chose not to enforce unique IDs. If we forced them to be unique, someone could just register a real student's number and lock them out of the app. We still needed to collect the IDs, though, because the library needs a real record for disciplinary follow-up if someone trashes a desk, which a pseudonym just can't provide. Claude surfaced the technical question, but the product answer was mine.

## Testing and Enforcement

The best rule I added to my harness was forcing Claude to prove a test actually failed on the old code before applying a fix. Otherwise, Claude would sometimes write tests that just passed vacuously no matter what. Looking back at the commit history, I can see a clear split: the corrections that I forced mechanically are solid, while the ones that rely on a written instruction in CLAUDE.md are flimsy.

### Testing

-   **Double-booking:** In [`2bb1e53`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/2bb1e53) I realised two overlapping requests could claim the same desk: the old code checked the desk was free, awaited the body, then inserted. Claude’s first concurrency test actually passed against the buggy code because localhost delivers data so fast the race window vanished. I forced the agent to rewrite the test to artificially hold the bodies back. It finally failed, and the fix we applied was a SQLite unique index plus a hard rule to never await anything between checking and inserting.
-   **History scaling:** At 50,000 log rows, requests took about 450ms and ~390MB of RAM, enough to crash the 256MB machine. In [`1717e58`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/1717e58) Claude rewrote the queries to read only live claims, giving 1.8ms and 85MB.
-   **Accessibility:** Testing found over 80 contrast failures, including a 2.1:1 logo. [`85e1680`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/85e1680) fixed the design tokens to reach zero issues, and checks for accessibility happen at build.

### Instructions

-   **UI state leakage:** When checking across two browser profiles, a stranger could see an active “Check in” button on a claimed desk. The server rejected the click, but the UI misled. The fix landed in [`f9f61c6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/f9f61c6) and I added to CLAUDE.md that permissions must be enforced on the server, not by hiding buttons. Because this was a frontend rendering issue, it is not caught by the backend tests. It relies entirely on the CLAUDE.md instruction and manual visual checks to prevent recurrence.
-   **Tests against production:** My tests passed locally but failed on the live deployment ([`b4f610c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-evealitaylor/commit/b4f610c)) because leftover two-hour holds from manual testing blocked new claims. Rather than wipe the database, I had Claude add a function that finds a free desk and cleans up after itself, and I noted in CLAUDE.md never to assume an empty database.

## Verification

The test suite passes locally, in Docker and against the live URL. I checked the multi-user requirement by hand with two Chrome profiles and on various screen sizes, evaluating keyboard navigation, resizing and speed. The successful live test runs and build checks are visible in the CI logs for my final deployment commit.

## What the History Shows

The enforced corrections are the ones I trust. The two that rest only on a line in CLAUDE.md I trust least, because an instruction biases the agent without forcing it. While the advisory rules haven't been tested by a recurrence yet, the database unique index rule guarantees the double-booking bug can never return, regardless of what the agent writes.

There are two limits. Every catch came from me noticing something, often late and through manual checks or profiling, so the harness reduced repeat errors but did not find new ones. And making tests fail first cost real time, most of all in the concurrency case. With another pass I would convert the two advisory rules into tests earlier. What I would keep is the division of labour: Claude implemented quickly and well, while the decisions that shaped the product accounts, ID handling, and what to leave out, stayed with me.
