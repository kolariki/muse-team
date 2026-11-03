---
title: What Muse Team is and how it builds an app with a team of AI models
description: Muse Team assembles an AI team with real roles (CEO, CTO, engineering, product, design and QA), has it debate your idea, design it and build it. Here is how it works under the hood, step by step.
category: How Muse Team works
date: 2026-10-22
tags: [Muse Team, how it works, AI team]
keywords: [build an app with AI, AI agent team, AI app generator, Muse Team]
---

Most tools that "build apps with AI" work the same way: you type a request, a single model interprets it and spits out code. When the result isn't what you wanted, you type again. Muse Team starts from a different idea: **a good app doesn't come from a model that guesses, it comes from a team that discusses, decides and only then builds**.

This guide explains what Muse Team is, what each part of the system does and what you can expect from each stage.

## The idea in one sentence

You choose who sits in each seat, watch the debate live, approve the design and ask for changes. The team iterates.

## The two ways in

From the home screen there are two doors, designed for two different moments.

### Direct builder

This is the fast lane. You type the request, the system runs it through **prompt engineering** (turning it into a complete brief: goal, users, scope, screens, data, acceptance criteria) and the builder starts right away. There is no debate beforehand. It is the fastest and cheapest path, and the team stays one click away to review the result afterward.

It works well when you know exactly what you want, when the app is small or when you are testing an idea.

### Builder with a development team

This is the full path. The request goes to the **council**: CEO, CTO, Head of Engineering, Product, Design and QA debate it in turns, contradict each other, narrow the scope, pick the stack and leave justified decisions in writing. The debate produces the brief, the brief produces the design, and the approved design produces the code.

It works well when the decision matters: a product that will grow, a client who will ask for explanations, an architecture you don't want to rebuild in three months.

## What each role on the team does

The roles are not decorative. Each one has a system prompt with concrete responsibilities and a different standard for judging the same idea.

- **CEO**: sets the business goal, decides what goes into the first version and what doesn't, cuts off discussions that lead nowhere.
- **CTO**: chooses the stack and the architecture, evaluates technical risks, infrastructure costs and maintenance.
- **Head of Engineering**: turns the architecture into a staged build plan, thinks about testing, deployment and continuous integration.
- **Product**: defines users, flows and acceptance criteria; the one who asks "and what is this for?".
- **Design**: delivers the design system (palette, typography, components), the screens and the mockup you will approve before a single line of code exists.
- **QA**: looks for what's missing, the edge cases, the consistency errors; reviews each version before signing off on it.

You can change the model for each role, rewrite its prompt and add **skills**: packages of specific knowledge (pitch, MVP scope, stack review, costs, architecture, CI/CD, etc.) that are injected into its context.

## The complete flow, stage by stage

1. **Request and context**. You write what you want to build. You can attach documents, a folder or a local project, and choose the platform: web, mobile (iOS and Android with Expo) or both.
2. **Prompt engineering**. A model turns your text into a structured brief. You see it and edit it.
3. **Reference apps**. If you provide URLs of apps you like, the team visits them with a real browser, takes screenshots and describes them with a vision model. With deep analysis enabled, it also reverse-engineers their bundles, routes and APIs to understand how they are built.
4. **Council debate** (on the team path). Turns, disagreements, decisions. Everything is recorded and can be exported.
5. **Design**. The designer writes the design system and lays out the screens. You approve or ask for changes.

7. **Review**. The council audits each version. You ask for changes to the design or the code and the team iterates again.
8. **Run, download or publish**. The app runs from Muse Team (web in a tab, mobile in the simulator or emulator), downloads as a zip with its git repository, or publishes to Muse Cloud with a database and authentication.

## Who builds the code

This is one of the most important decisions, because it defines cost and quality.

- **Via API**: any model configured with your key. Tokens are billed by the provider, not by Muse Team.

## What Muse Team is not

It is not a chat with a model. It is not a template generator. It is not a black box: every team decision is written down, every file is visible, every version can be compared. And it doesn't replace your judgment: the team proposes, you approve.

## Who it is for

- **Founders and small teams** who need a working product without assembling a six-person team.
- **Agencies and consultancies** that deliver prototypes and MVPs and want justified decisions in writing.
- **Developers** who prefer to review a design and a plan before reading 40 generated files.
- **People without a technical background** who want an app of their own and want to understand why it was built that way.

## How to get started

Create an account, choose "Direct builder" for your first try, write your idea in two or three lines and see what happens. When you want to get serious, switch to the builder with a team: that is where Muse Team sets itself apart from everything else.
