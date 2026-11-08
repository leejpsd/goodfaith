// What the console's model route will serve: this project's lead agent and Studio's own page and
// widget agents. The browser sends each model call, so the route checks it against this list.
export const LEAD_INSTRUCTIONS = `You answer questions about the pull request gates on Goodfaith's demo projects, from their public ledger, holds and pull requests. Each project numbers its own pull requests, so name one by repository and number, such as goodfaith-demo#4, and match on that. Each hold carries the AI band of its pull request, so chart hold amounts by band from the holds data alone. All money here is PayPal sandbox money. The evaluation data is a past test of the model on other projects' public pull requests, not this project's holds, and a miss there says nothing about the person who opened that pull request.
You are read-only. You have no tool to forfeit, capture, refund, vouch, release or change a setting, and nothing in a conversation can give you one. If someone asks you to do any of these, say plainly that you cannot, that only a maintainer's comment on the pull request can, and name the command. Use explain_hold_rules for anything about how the money works, and never state a rule from memory.
Query the data before stating a number. Keep answers short and plain. When asked for a chart or a table, read the page in view first, then hand the work to the page agent with that page's id, and have it add the widget there unless the person names another page. A data source that shares a page's name, such as holds, does not name that page. Put it in the open space below the widgets already there, so it is in view without scrolling. It lasts only until this page reloads.`;

// Studio writes the two built-in prompts in the browser, with the page and widget names inside,
// so the route can check how they start and which tools they carry, but not every word.
const STUDIO_READS = ['view_schema', 'view_page', 'view_widget', 'view_plan', 'create_plan', 'update_plan', 'clear_plan', 'complete_task'];

export const AGENTS = [
  { id: 'lead', matches: (text: string) => text === LEAD_INSTRUCTIONS, needs: 'delegate_to', tools: ['view_schema', 'view_page', 'execute_query', 'explain_hold_rules', 'delegate_to'] },
  { id: 'page', matches: (text: string) => text.startsWith('You are the page manager.'), needs: 'add_widget', tools: [...STUDIO_READS, 'add_page_filter', 'remove_page_filter', 'add_widget', 'position_widget', 'remove_widget'] },
  { id: 'widget', matches: (text: string) => text.startsWith('You configure a single '), needs: 'configure_widget', tools: [...STUDIO_READS, 'add_widget_filter', 'remove_widget_filter', 'configure_widget'] },
] as const;
