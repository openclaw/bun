export type A<T> = { child: T };
export type B<T> = { child: T };
export type Base = { a: "x" | "y"; b: number | string; n: number; left: unknown; right: unknown };
export type Left = { a: "x" | "y"; b: number; n: number; left: A<A<A<A<A<A<number>>>>>>; right: unknown };
export type Right = { a: "x"; b: number | string; n: number; left: unknown; right: B<B<B<B<B<B<number>>>>>> };
