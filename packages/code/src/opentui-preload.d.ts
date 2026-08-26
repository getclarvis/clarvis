/**
 * `@opentui/solid/preload` ships no declaration.
 *
 * @remarks It is imported for its side effect alone — it registers the Bun
 * loader plugin that applies the Solid JSX transform — and `cli.ts` reaches it
 * through a dynamic `import()`, which unlike a bare side-effect import needs the
 * module to have a type.
 */
declare module "@opentui/solid/preload";
