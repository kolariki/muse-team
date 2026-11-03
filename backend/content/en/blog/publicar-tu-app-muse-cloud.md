---
title: Publishing your app with Muse Cloud: your own git, one click to go live, database and authentication
description: How Muse Team publishes what it builds: a git repository per project, one-click publishing (on Muse Team, Cloudflare or Fly), database and authentication with Neon or Supabase, migrations, and how to take everything to your own infrastructure.
category: Publishing and mobile
date: 2026-10-22
tags: [Muse Cloud, publishing, hosting, database]
keywords: [publish an AI-built app, hosting for a generated app, one-click deploy, Supabase Neon with AI, Vercel Railway alternative for AI-built apps]
---

Building the app is half the journey. The other half is getting someone to use it: a public URL, a database that persists, users who can sign in. **Muse Cloud** covers that stretch without you having to learn how to deploy.

## What every project has from the start

### Its own git repository

Every build lives in its own repository. Every version the council approves is a commit; you can compare versions, roll back to an earlier one and see what changed file by file. The repository can be:

- **Downloaded as a zip** from the project card.
- **Cloned** with git from your project's private URL.
- **Pushed to GitHub** with one click, to a repository in your account.

It is your code. There is no lock-in.

### Running the app without publishing

From the project card, "Run app" opens the application in a Muse Team tab, on top of the home screen, with its loader. For mobile apps, it opens the iOS simulator or the Android emulator with a live view of the device. It is for testing before you publish.

## Publishing with one click

In the builder's "Cloud" panel you choose the destination:

- **Muse Team (local)**: the app is served from the same Muse Team instance, at a URL like `/apps/your-app`. It is immediate and works for demos, internal testing and personal-use apps.
- **Cloudflare**: the app is deployed on Cloudflare's network (Pages and Workers), with a custom domain if you configure one. Ideal for web apps with public traffic.
- **Fly**: for apps with a backend that needs a running process (APIs, queues, websockets).

The panel shows the publishing log line by line, the status and the final URL. Unpublishing is another click.

## Database and authentication

A real app needs to store data and know who each user is. Muse Cloud provisions that with the providers the industry already uses:

- **Neon**: serverless Postgres. Muse Team creates the project, the database and the connection string, and injects it into your app as an environment variable.
- **Supabase**: Postgres plus authentication, storage and automatic APIs. Muse Team creates the project and configures the public and private keys.

You enter the credentials for your Neon or Supabase account once, in the Muse Cloud settings, and from then on each project provisions itself.

### Migrations

When the builder changes the data model between versions, Muse Team generates a **migration kit**: the SQL scripts, the order in which to apply them and the instructions. You review it and apply it from the panel. There is no magic that touches your database without you seeing it.

## Taking everything with you

Muse Cloud is designed so you can leave whenever you want:

- The code is in your git.
- The database is in your Neon or Supabase account.
- The environment variables are documented in the project.
- The deployment plan (what gets built, what gets served, which port) is written in the repository.

You can deploy to Vercel, Railway, your own server or wherever you prefer by following that plan. Muse Team holds nothing back that would stop you.

## What it costs

Muse Team does not charge for publishing on Muse Team (local). Cloudflare, Fly, Neon and Supabase have generous free plans and charge for usage once you exceed them, directly to your account with them. Muse Team does not intermediate those charges.

## Basic security

- Provider credentials are stored encrypted in your Muse Team account.
- Each published app has its own environment variables; none sees another's.
- Your app's keys (payment API, email, etc.) are entered as **project secrets** and are never written into the code.

## In summary

You build, test, publish, connect a database and users, and everything stays in your git and your accounts. Muse Cloud removes the tedious part without locking you in.
