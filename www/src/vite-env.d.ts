/// <reference types="vite/client" />

// SCSS module declarations
declare module '*.module.scss' {
    const classes: { [key: string]: string }
    export default classes
}

declare module '*.scss' {
    const content: { [key: string]: string }
    export default content
}

declare module '*.css' {
    const content: { [key: string]: string }
    export default content
}
