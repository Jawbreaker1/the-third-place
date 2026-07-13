import {
  defaultTreeAdapter,
  Parser,
  Tokenizer,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type TokenHandler,
  type TokenizerOptions,
  type TreeAdapter,
} from "parse5";

export interface HtmlParseBudget {
  maxInputBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxAttributesPerTag: number;
  maxTotalAttributes: number;
}

class HtmlParseBudgetExceeded extends Error {}

class BudgetTokenizer extends Tokenizer {
  private attributesInTag = 0;
  private totalAttributes = 0;

  constructor(
    options: TokenizerOptions,
    handler: TokenHandler,
    private readonly budget: HtmlParseBudget,
  ) {
    super(options, handler);
  }

  protected override _createStartTagToken(): void {
    this.attributesInTag = 0;
    super._createStartTagToken();
  }

  protected override _createEndTagToken(): void {
    this.attributesInTag = 0;
    super._createEndTagToken();
  }

  protected override _createAttr(attrNameFirstCh: string): void {
    this.attributesInTag += 1;
    this.totalAttributes += 1;
    if (
      this.attributesInTag > this.budget.maxAttributesPerTag ||
      this.totalAttributes > this.budget.maxTotalAttributes
    ) {
      throw new HtmlParseBudgetExceeded();
    }
    super._createAttr(attrNameFirstCh);
  }
}

const budgetedTreeAdapter = (budget: HtmlParseBudget): TreeAdapter<DefaultTreeAdapterMap> => {
  let createdNodes = 0;
  const templateParents = new WeakMap<DefaultTreeAdapterTypes.DocumentFragment, DefaultTreeAdapterTypes.Template>();
  const countNode = <T>(node: T): T => {
    createdNodes += 1;
    if (createdNodes > budget.maxNodes) throw new HtmlParseBudgetExceeded();
    return node;
  };
  const assertInsertionDepth = (parentNode: DefaultTreeAdapterTypes.ParentNode): void => {
    let depth = 1; // The child that is about to be inserted.
    let current: DefaultTreeAdapterTypes.Node | null | undefined = parentNode;
    while (current) {
      depth += 1;
      if (depth > budget.maxDepth) throw new HtmlParseBudgetExceeded();
      current = defaultTreeAdapter.getParentNode(current) ??
        templateParents.get(current as DefaultTreeAdapterTypes.DocumentFragment) ??
        null;
    }
  };
  const appendChild = (
    parentNode: DefaultTreeAdapterTypes.ParentNode,
    newNode: DefaultTreeAdapterTypes.ChildNode,
  ): void => {
    assertInsertionDepth(parentNode);
    defaultTreeAdapter.appendChild(parentNode, newNode);
  };
  const insertBefore = (
    parentNode: DefaultTreeAdapterTypes.ParentNode,
    newNode: DefaultTreeAdapterTypes.ChildNode,
    referenceNode: DefaultTreeAdapterTypes.ChildNode,
  ): void => {
    assertInsertionDepth(parentNode);
    defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode);
  };

  return {
    ...defaultTreeAdapter,
    createDocument: () => countNode(defaultTreeAdapter.createDocument()),
    createDocumentFragment: () => countNode(defaultTreeAdapter.createDocumentFragment()),
    createElement: (tagName, namespaceURI, attrs) =>
      countNode(defaultTreeAdapter.createElement(tagName, namespaceURI, attrs)),
    createCommentNode: (data) => countNode(defaultTreeAdapter.createCommentNode(data)),
    createTextNode: (value) => countNode(defaultTreeAdapter.createTextNode(value)),
    appendChild,
    insertBefore,
    setTemplateContent(templateElement, contentElement) {
      defaultTreeAdapter.setTemplateContent(templateElement, contentElement);
      // Template contents live in a detached DocumentFragment. Preserve their
      // semantic parent so nested templates cannot reset the depth budget.
      templateParents.set(contentElement, templateElement);
    },
    insertText(parentNode, text) {
      const children = defaultTreeAdapter.getChildNodes(parentNode);
      const previous = children.at(-1);
      if (previous && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      appendChild(parentNode, countNode(defaultTreeAdapter.createTextNode(text)));
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const children = defaultTreeAdapter.getChildNodes(parentNode);
      const previous = children[children.indexOf(referenceNode) - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      insertBefore(parentNode, countNode(defaultTreeAdapter.createTextNode(text)), referenceNode);
    },
  };
};

/**
 * Parse with limits enforced by parse5's real tree operations. This avoids
 * trying to approximate HTML tokenization in a separate pre-parser, where
 * malformed comments, foreign content and ignored self-closing flags differ.
 */
export const parseHtmlWithBudget = (
  raw: string,
  budget: HtmlParseBudget,
): DefaultTreeAdapterTypes.Document | undefined => {
  if (
    budget.maxInputBytes < 1 ||
    budget.maxNodes < 1 ||
    budget.maxDepth < 2 ||
    budget.maxAttributesPerTag < 1 ||
    budget.maxTotalAttributes < 1 ||
    Buffer.byteLength(raw, "utf8") > budget.maxInputBytes
  ) {
    return undefined;
  }
  try {
    const parser = new Parser<DefaultTreeAdapterMap>({ treeAdapter: budgetedTreeAdapter(budget) });
    parser.tokenizer = new BudgetTokenizer(parser.options, parser, budget);
    parser.tokenizer.write(raw, true);
    return parser.document;
  } catch {
    return undefined;
  }
};
