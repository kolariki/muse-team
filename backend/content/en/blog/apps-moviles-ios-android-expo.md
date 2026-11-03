---
title: Mobile apps for iOS and Android with AI: how Muse Team builds with Expo and runs them in the simulator
description: How Muse Team builds mobile apps with React Native and Expo, how to choose between web, mobile or both from a single codebase, what you need installed to run them in the iOS simulator and the Android emulator, and how they get published to the stores.
category: Publishing and mobile
date: 2026-10-22
tags: [mobile apps, iOS, Android, Expo, how it works]
keywords: [build a mobile app with AI, iOS Android app with artificial intelligence, Expo React Native with AI, generate a phone app, iOS simulator Android emulator]
---

A phone app has rules of its own: gesture navigation, small screens, stores with review processes, two operating systems. Muse Team builds mobile apps with a proven stack and runs them on a virtual device so you can see them before publishing.

## Choosing the platform

The project form has three options:

- **Web app**: browser, desktop and mobile. The simplest and the fastest to publish.
- **Mobile app**: iOS and Android with **Expo** (React Native). One codebase, two stores.
- **Both**: a single codebase that runs as a web app and as a native app. Expo makes it possible and Muse Team configures it so the screens share logic and styles.

The choice affects everything that follows: the brief, the design (the designer works with mobile patterns where appropriate), the builder and the way the app is run.

## Why Expo

**Expo** is the most widely used way to build apps with React Native. It solves what hurts most on mobile: the build environment, native modules, over-the-air updates and store publishing. For an AI builder it is ideal because the project has a standard structure, abundant documentation and few surprises.

The builder receives platform-specific instructions: native navigation, safe areas, keyboard handling, efficient lists, permissions, and the difference between what works on the web and what does not.

## Running the app on a virtual device

From the project card, "Run app" does the following for a mobile app:

1. Starts the project's Expo services.
2. Opens the **iOS simulator** (on a Mac with Xcode) or the **Android emulator** (with Android Studio or the SDK), depending on what is available.
3. Shows the device screen **live inside Muse Team**, where you can tap and navigate.

If no virtual device is available, Muse Team says so on screen and tells you what to install.

### Requirements

| Platform | What you need on the machine where Muse Team runs |
|---|---|
| iOS | A Mac with Xcode and at least one simulator runtime installed |
| Android | Android Studio or the Android SDK with a virtual device created |
| Both | The above; Muse Team picks whichever is ready |

If you use Muse Team in the cloud, the simulators run on the server and need those tools installed there. On a Linux server, the Android emulator is viable; the iOS simulator requires macOS.

## Testing on your own phone

Since the project is an Expo project, you can open it on your phone with the Expo Go app by scanning the QR code shown by the development server, or generate a development build. This happens outside Muse Team, but the project comes ready for it.

## Publishing to the stores

Publishing to the App Store and Google Play involves steps that no AI can skip: developer accounts, certificates, human review. What Muse Team does is leave the project ready for **EAS Build**, Expo's build service, with identifiers, icons and splash screens configured. From there, you follow Expo's documentation to submit to each store.

## What it builds well and what to avoid

It works very well for:

- Personal or business management apps (appointments, orders, inventory, scheduling).
- Apps with lists, forms, detail views, search and filters.
- Apps that consume an API (your own or a third party's).
- Apps with notifications, camera, location and the usual permissions.

Think twice for:

- Games with intensive graphics.
- Apps that depend on very specific native modules without Expo support.
- Apps with extreme performance requirements (real-time video, heavy processing).

## A piece of advice

If you are not sure you need a native app, **start with the web**. A well-made web app installs on the phone, works offline for the basics and does not go through the stores. When you need native push notifications, deep device access or a presence in the stores, switch to "Both" and take advantage of the code you already have.

## In summary

Choose mobile or both, let the team design with mobile patterns, run the app in the simulator or the emulator from Muse Team, and publish with EAS when it is ready. One codebase, two stores, and the web for free.
