---
title: Frequently asked questions
---

## What is Muse Team?

Muse Team is a platform for building applications with a **team of AI models with roles**: CEO, CTO, Head of Engineering, Product, Design and QA. You describe your idea, the team debates it, studies reference apps, designs the screens, writes the code and reviews it. You approve each step and the app is ready to run, download or publish.

## Which AI does it use?

Muse, by Meta. The whole team reasons with Muse Spark and Muse Wonder through the Meta Model API, and Muse Code writes the code. Add your Meta key in “Models and API keys” and you are set.

## What is the Direct builder?

The fast route: your request goes through prompt engineering, becomes a complete brief, and the builder starts immediately, with no team debate. It is the fastest and the cheapest. The team stays one click away to audit the result afterward.

## What is the Builder with a development team?

The full route: the team researches the references, debates your idea in turns, leaves justified decisions, produces the brief, designs the screens you approve, and only then builds. Every version is reviewed and you can request changes.

## Can I build mobile apps?

Yes. You choose web, mobile (iOS and Android with Expo) or both from a single codebase. Mobile apps run from Muse Team in the iOS simulator or the Android emulator, with the device screen live, if those tools are installed where Muse Team runs.

## What are reference apps?

URLs of apps you like. Muse Team visits them with a real browser, takes screenshots, describes them with a vision model and assembles a research document that the designer and the builder read. With "Deep analysis and reverse engineering", it also analyzes their bundles, routes and APIs to replicate them faithfully (requires REA installed and a desktop builder). There is no additional cost: it runs on your subscription or your API key.

## Where does my code live?

In your account, in its own git repository per project. You can download it as a zip, clone it, push it to your GitHub with one click and compare versions. It is yours and it is portable.

## How do I publish the app?

From the builder's Cloud panel: on the Muse Team instance itself with one click, or on Cloudflare or Fly with your accounts. Muse Cloud also provisions a database and authentication with Neon or Supabase and generates migration kits when the data model changes.

## What happens with my API keys?

They are stored encrypted in your account, used only for your requests, and you can view them (last characters), replace them and delete them whenever you want. They are never written into your projects' code. We recommend creating keys specifically for Muse Team with a spending limit.

## Can I run Muse Team on my own machine or server?

Yes. There is a Docker image and a guide for deploying it on Railway or on any server. Each user connects their own keys and subscriptions.

## What happens if a build fails or gets interrupted?

The state is saved. You can resume it from where it left off, change the builder or the model, and try again. Desktop agents fix compilation errors on their own during the build.

## Can I request changes afterward?

Yes. You request changes to the design or the code, the builder applies them, and the council reviews the new version. You can also call in the team to audit a direct build.

## Can I save my team configuration?

Yes. An experiment saves the theme, mode, team (provider, model, prompt and skills for each role) and debate settings, so you can reuse it with other ideas and compare results.

## What are skills?

Packages of specific knowledge (pitch, MVP scope, stack review, costs, architecture, CI/CD, among others) that are added to a role's context so it works with sharper judgment. They are chosen per role from the team editor.

## Which languages does it work in?

The interface is in Spanish and English. The team can work in Rioplatense Spanish, neutral Spanish, English or other languages you choose for the project; the models handle it without trouble.

## Is Muse Team for people without a technical background?

Yes. You describe the problem in your own words, the team decides the technical part and explains it to you, and you approve the design before any code exists. If you are technical, you can set the stack, edit the brief and review every file.
