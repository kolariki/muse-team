---
title: How to write an app request so the AI builds it well (applied prompt engineering)
description: What to include and what to leave out of your app request, how Muse Team's automatic prompt engineering works, examples of good and bad requests, and a template you can copy.
category: Prompt engineering and references
date: 2026-10-22
tags: [prompt engineering, how it works, practical guide]
keywords: [prompt engineering, how to ask AI for an app, write a prompt to generate an app, brief for app development, prompt template]
---

Everything starts with the request. A vague request produces a generic app; a clear request produces an app that looks like what you had in mind. This guide explains what Muse Team does with your text and how to write it to get the most out of it.

## What Muse Team does with what you write

When you tap "Generate prompt engineering for my text", a model transforms your request into a **structured brief** with these sections:

- **Goal**: what problem the app solves and for whom.
- **Users and roles**: who uses it and what each one can do.
- **Scope of the first version**: what's in and, just as important, what's out.
- **Screens and flows**: the list of screens and how you navigate between them.
- **Data**: the main entities and their relationships.
- **Business rules**: what the app has to enforce.
- **Integrations**: payments, email, WhatsApp, maps, whatever is needed.
- **Acceptance criteria**: how we know it is done.
- **Constraints**: stack, language, platform, accessibility.

That brief is what the team reads (on the council path) or the builder reads directly (on the direct path). You see it and edit it before anything starts.

## What a good request has

### The problem, not the solution

"My clients text me on WhatsApp to book appointments and they end up double-booked" is better than "an appointment app". The first gives the team the context to decide; the second forces it to guess.

### Who uses it

"Me (the owner), two employees and the clients" defines three roles with different permissions. Without that, the AI assumes a single type of user.

### The three or four main flows

"Book an appointment, cancel it, get a reminder the day before, see the day's schedule". If you name them, they show up in the first version; if you don't, they may be left out.

### What you DON'T want

"No online payments for now", "no password sign-up, use a magic link". Saying what's out keeps the app from filling up with features you didn't ask for.

### References

"Make it look like Calendly but in Spanish and simpler". With reference apps, Muse Team visits them, analyzes them and uses them as a yardstick (or as a blueprint, if you enable reverse engineering).

### Platform and language

Web, mobile or both; Rioplatense Spanish, neutral Spanish or English. They are two clicks in the form, but it helps to have them clear.

## What a good request doesn't need

- **Technical stack**, unless you have a real constraint. The CTO chooses it better than you if you are not technical, and if you are technical, you can set it in one line ("Next.js and Postgres").
- **Design details** down to colors and typefaces. That is what the designer is for, and references say more than words.
- **Marketing copy**. The brief is a working document, not a landing page.

## Examples

### Weak request

> An app for my food business.

Likely result: a generic catalog with a cart, with no idea whether you sell for delivery, whether you charge online, whether you have tables.

### Good request

> I run a rotisserie. I want my customers to see the daily menu, put together an order and choose pickup or delivery. I take cash or bank transfer on receipt, no online payments for now. I need to see the day's orders on a simple screen from my phone and mark them as ready. Make it look like Rappi but without all the clutter. Rioplatense Spanish, web.

Likely result: exactly that, with a brief that also asks you about delivery hours and delivery zones.

## Template to copy

```
What problem it solves:
Who uses it (roles):
The 3 or 4 main flows:
What is NOT in the first version:
Required integrations:
Reference apps:
Platform (web / mobile / both) and language:
Constraints (stack, hosting, accessibility), if any:
```

Five minutes filling this in are worth more than an hour of changes later.

## Which model does the prompt engineering

## After the brief

- In the **direct builder**, the brief goes straight to the builder.
- In the **builder with a team**, the brief is the starting point of the debate: the council discusses it, narrows it and improves it before designing.

## In summary

Describe the problem, the users, the flows and what's out. Leave the stack and the design to the team unless you have a real constraint. And read the brief before starting: it is the cheapest moment to make corrections.
