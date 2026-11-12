// Type declarations for `oxidom/jest-environment` (DESIGN §32, §34). jest-environment-oxidom builds its class
// here with its own `require`; the class's type is declared by that package (packages/jest-environment-oxidom).
export function environmentClass(jestRequire: (id: string) => any): new (config: any, context: any) => any;
