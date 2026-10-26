// Type declarations for `jetdom/jest-environment` (DESIGN §32, §34). jest-environment-jetdom builds its class
// here with its own `require`; the class's type is declared by that package (packages/jest-environment-rsdom).
export function environmentClass(jestRequire: (id: string) => any): new (config: any, context: any) => any;
