# Implementing Flutter applications

Use this guidance when changing Flutter application code. The repository's declared
targets and existing architecture decide what to build; Flutter support alone does not
mean every app ships to iOS, Android and Web.

## Before changing code

- Read `pubspec.yaml`, the Dart and Flutter SDK constraints, lints, and the relevant
  source and tests. Follow the app's existing state-management, navigation, dependency
  injection and file-layout patterns.
- Check which platform directories and integrations already exist (`ios/`, `android/`,
  and `web/`). Do not scaffold platforms, upgrade dependencies, or regenerate native
  projects unless the requested change requires it.
- Confirm the requested behavior and target platforms. Keep edits to shared Dart code
  when that is sufficient; change native configuration only for a platform capability
  that cannot be implemented in Flutter code.

## Structure and widget behavior

- Follow the repository's architecture. Where it has no established pattern, keep
  presentation in widgets, state and UI coordination in the app's chosen state layer,
  and data access behind repositories or services. Add a domain/use-case layer only
  when the behavior warrants it.
- Keep `build` methods focused on describing UI. Do not start requests, mutate shared
  state, or perform other one-time effects during build. Put asynchronous work in the
  existing controller, view-model, or state-management layer.
- Handle loading, empty, success and failure states where the feature has them. Dispose
  controllers, focus nodes, streams and other owned resources with their lifecycle.
- For layouts that run at multiple sizes, respond to available constraints rather than
  assuming a phone-sized viewport. Preserve the app's theme, navigation conventions,
  localization and accessible labels and semantics.

## iOS, Android and Web

- Treat the project's selected targets as a test matrix: shared UI and business logic
  should work on each target the project actually supports.
- Keep shared code independent of native-only libraries. In particular, browser-shared
  code must not directly depend on `dart:io`; isolate platform-specific work behind
  existing plugins, abstractions or conditional imports.
- Keep platform checks at integration boundaries. Do not fork ordinary UI by platform
  when responsive layout or existing design-system components can satisfy the request.
- For platform-specific behavior, inspect the plugin's supported platforms and the
  existing native configuration before adding it. Preserve existing signing, build,
  permission and deployment settings.
- Do not claim a platform build passed unless it was run for that target. iOS builds
  require macOS and Xcode; Android and Web builds require their configured toolchains.
  Record an unavailable target as a verification gap rather than treating another
  platform's build as proof.

## Tests and verification

- Add Dart unit tests for isolated logic and Flutter widget tests for rendered states,
  user interaction and layout behavior. Use `integration_test` only when the claim needs
  a running app or a real platform boundary.
- Follow the repository's Paved verification profile and run its declared checks.
  Common Flutter checks are `flutter analyze` and `flutter test`; run a platform build
  only when that platform is in scope and its toolchain is available.
- Match tests to the claim: a passing widget test does not prove an iOS, Android or Web
  build, and a successful build does not prove the expected interaction.

## Official references

- [Flutter app architecture](https://docs.flutter.dev/app-architecture)
- [Supported platforms](https://docs.flutter.dev/reference/supported-platforms)
- [Platform integration](https://docs.flutter.dev/platform-integration)
- [Testing Flutter apps](https://docs.flutter.dev/testing/overview)
- [Dart I/O library](https://api.dart.dev/dart-io/)
- [Flutter project configuration](https://docs.flutter.dev/tools/pubspec)
