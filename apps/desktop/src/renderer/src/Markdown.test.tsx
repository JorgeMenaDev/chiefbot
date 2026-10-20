import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.tsx";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("a reply shows bold, lists and tables as GitHub renders them", () => {
  const html = render("The **Cloud Resource Manager API** is on.\n\n- one\n- two\n\n| API | State |\n| --- | --- |\n| BigQuery | On |");

  expect(html).toContain("<strong>Cloud Resource Manager API</strong>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain('<div class="chat-markdown-table"><table><thead><tr><th>API</th><th>State</th></tr></thead>');
  expect(html).toContain("<td>BigQuery</td>");
});

test("web links open outside the app, and any other link is plain text", () => {
  const html = render("[Docs](https://cloud.example/docs), [mail](mailto:octo-user@example.com), [here](./notes.md), [bad](javascript:alert(1))");

  expect(html).toContain('<a href="https://cloud.example/docs" title="https://cloud.example/docs" target="_blank" rel="noreferrer">Docs</a>');
  expect(html).toContain('href="mailto:octo-user@example.com"');
  expect(html).toContain("<span>here</span>");
  expect(html).toContain("<span>bad</span>");
  expect(html).not.toContain("javascript:");
});

test("a fenced block shows its language and a copy button over the code; inline code stays inline", () => {
  const html = render("Run `gcloud`:\n\n```bash\ngcloud services list\n```");

  expect(html).toContain("<code>gcloud</code>");
  expect(html).toMatch(/<div class="chat-markdown-codeblock">.*>bash<\/span>.*aria-label="Copy code".*<pre><code class="language-bash">gcloud services list\n<\/code><\/pre><\/div>/s);
});

test("raw HTML in a reply never renders", () => {
  const html = render('Hi <b onclick="x()">there</b>\n\n<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">');

  expect(html).not.toContain("<b");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("there");
});

test("a text's images show as its `image` says", () => {
  const html = renderToStaticMarkup(<Markdown text="![Screenshot 1](task-1-1.png)" image={(src, alt) => <b>{`${alt}: ${src}`}</b>} />);

  expect(html).toContain("<b>Screenshot 1: task-1-1.png</b>");
});
