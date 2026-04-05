export class StateParser {
    page;
    cdp;
    elementCounter = 0;
    constructor(page, cdp) {
        this.page = page;
        this.cdp = cdp;
    }
    async parse() {
        this.elementCounter = 0;
        const { nodes } = await this.cdp.send('Accessibility.getFullAXTree');
        const uiElements = [];
        for (const node of nodes) {
            if (this.isInteractive(node)) {
                const element = await this.nodeToUIElement(node);
                if (element) {
                    if (node.backendDOMNodeId) {
                        try {
                            const { model } = await this.cdp.send('DOM.getBoxModel', {
                                backendNodeId: node.backendDOMNodeId
                            });
                            if (model && model.content && model.content.length >= 8) {
                                const x = model.content[0];
                                const y = model.content[1];
                                const width = model.content[2] - model.content[0];
                                const height = model.content[7] - model.content[1];
                                element.boundingClientRect = { x, y, width, height };
                                uiElements.push(element);
                            }
                        }
                        catch (e) {
                            // Node might be invisible or gone
                        }
                    }
                }
            }
        }
        return {
            url: this.page.url(),
            title: await this.page.title(),
            elements: uiElements
        };
    }
    isInteractive(node) {
        const interactiveRoles = [
            'button', 'link', 'textbox', 'checkbox', 'combobox',
            'listbox', 'menuitem', 'radio', 'searchbox', 'slider',
            'spinbutton', 'switch', 'tab', 'treeitem'
        ];
        return interactiveRoles.includes(node.role?.value) && !node.ignored;
    }
    async nodeToUIElement(node) {
        const role = node.role?.value || 'unknown';
        const name = node.name?.value || '';
        const description = node.description?.value || '';
        const state = {};
        if (node.properties) {
            for (const prop of node.properties) {
                if (prop.name === 'disabled')
                    state.disabled = prop.value.value;
                if (prop.name === 'hidden')
                    state.hidden = prop.value.value;
                if (prop.name === 'focused')
                    state.focused = prop.value.value;
                if (prop.name === 'checked')
                    state.checked = prop.value.value;
            }
        }
        if (!name && role !== 'textbox')
            return null;
        return {
            id: this.elementCounter++,
            role,
            name,
            description,
            boundingClientRect: { x: 0, y: 0, width: 0, height: 0 },
            state
        };
    }
}
//# sourceMappingURL=state-parser.js.map