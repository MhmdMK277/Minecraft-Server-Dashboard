// TypeScript 7 requires declarations for side-effect imports of non-code assets.
declare module '*.css' {}
declare module '*.svg' {
  const src: string
  export default src
}
declare module '*.png' {
  const src: string
  export default src
}
