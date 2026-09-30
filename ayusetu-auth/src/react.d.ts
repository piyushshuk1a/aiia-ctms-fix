declare namespace React {
    function cloneElement(element: any, props: any): any;
    type ReactNode = any;
    class Component<P = {}, S = {}> {
        constructor(props: P);
        props: Readonly<P>;
        state: Readonly<S>;
        setState(update: Partial<S> | ((previous: S) => Partial<S>), callback?: () => void): void;
        forceUpdate(callback?: () => void): void;
    }
    function createElement(type: any, props?: any, ...children: any[]): any;
    const Fragment: any;
}
declare const ReactDOM: {
    render: (element: any, container: Element | null) => void;
};
declare namespace JSX {
    interface Element {
    }
    interface ElementClass {
        render(): any;
    }
    interface ElementAttributesProperty {
        props: {};
    }
    interface ElementChildrenAttribute {
        children: {};
    }
    interface IntrinsicAttributes {
        key?: string | number;
    }
    interface IntrinsicElements {
        [elemName: string]: any;
    }
}
