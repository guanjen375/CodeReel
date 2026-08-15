import http from 'node:http';

const port = 3030;
const tasks = [];
let nextId = 1;

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/tasks') {
    return json(response, 200, tasks);
  }

  if (request.method === 'POST' && request.url === '/tasks') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || '{}');
    if (!String(parsed.title || '').trim()) {
      return json(response, 400, { error: 'title is required' });
    }
    const task = { id: nextId++, title: parsed.title.trim(), completed: false };
    tasks.push(task);
    return json(response, 201, task);
  }

  return json(response, 404, { error: 'not found' });
});

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

server.listen(port, () => console.log(`TaskBoard listening on ${port}`));
