declare module 'react' {
  export type ReactNode = any
  export type ElementType = any
  export type Dispatch<A> = (value: A) => void
  export type SetStateAction<S> = S | ((prev: S) => S)
  export interface FC<P = {}> {
    (props: P & { children?: ReactNode }): any
  }
  export function useState<S>(
    initialState: S | (() => S)
  ): [S, Dispatch<SetStateAction<S>>]
  export function useEffect(
    effect: (...args: any[]) => any,
    deps?: any[]
  ): void
  export function useMemo<T>(factory: () => T, deps: any[]): T
  export function useRef<T>(initial: T | null): { current: T | null }
  export function useCallback<T extends (...args: any[]) => any>(cb: T, deps: any[]): T
  const React: any
  export default React
}

declare namespace React {
  type ReactNode = any
  type ElementType = any
  type Dispatch<A> = (value: A) => void
  type SetStateAction<S> = S | ((prev: S) => S)
  interface FC<P = {}> {
    (props: P & { children?: ReactNode }): any
  }
  interface ChangeEvent<T = any> {
    target: T & { value?: any; files?: FileList | null; checked?: boolean }
  }
  interface ClipboardEvent<T = any> {
    clipboardData: { getData: (type: string) => string }
    target: T
    preventDefault(): void
  }
  interface FormEvent<T = any> {
    target: T
    preventDefault(): void
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    [elem: string]: any
  }
}
