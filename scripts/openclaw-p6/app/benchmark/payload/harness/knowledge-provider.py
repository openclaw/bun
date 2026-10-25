"""Scripted Knowledge provider; the existing runtime controller owns this process."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import traceback

TARGET = "knowledge_ontology"
CALLS = (("tool_search", {"query": TARGET}),
         ("tool_describe", {"id": TARGET}),
         ("dispatch_action", {"id": TARGET, "args": {}}))


def ontology_result(value):
    assert value.get("available") is True and value.get("total", 0) > 0
    fingerprint = value.get("fingerprint")
    assert isinstance(fingerprint, str) and len(fingerprint) == 64
    return fingerprint


class ScriptedProvider:
    def __init__(self, receipt, model, marker):
        self.receipt = Path(receipt)
        self.model = model
        self.marker = marker
        self.requests = []
        self.errors = []
        self.outputs = []
        self.ontology = None
        self.lock = threading.Lock()

    def events(self, body, path):
        index = len(self.requests)
        self.requests.append({"index": index, "path": path, "model": body.get("model"),
                              "stream": body.get("stream")})
        assert index < 4, "Unexpected extra provider request; no retries are accepted"
        assert path == "/v1/responses" and body.get("model") == self.model
        assert body.get("stream") is True
        if index == 0:
            assert self.marker in json.dumps(body.get("input")), "Synthetic prompt marker missing"
        else:
            expected = f"call_p6_{index - 1}"
            outputs = [item for item in body.get("input", [])
                       if item.get("type") == "function_call_output" and item.get("call_id") == expected]
            assert len(outputs) == 1, f"Expected actual output for {expected}"
            value = json.loads(outputs[0]["output"])
            self.outputs.append({"callId": expected, "value": value})
            assert not isinstance(value, dict) or not (value.get("error") or value.get("isError"))
            if index == 1:
                assert isinstance(value, list) and any(item.get("name") == TARGET for item in value)
            elif index == 2:
                assert value.get("name") == TARGET and isinstance(value.get("parameters"), dict)
            else:
                assert value["tool"]["name"] == TARGET
                result = value["result"]
                assert result.get("isError") is not True and not result.get("error")
                texts = [item["text"] for item in result["content"] if item.get("type") == "text"]
                assert len(texts) == 1, "Expected the actual Knowledge JSON result"
                self.ontology = json.loads(texts[0])
                ontology_result(self.ontology)
        if index < 3:
            name, args = CALLS[index]
            assert any(tool.get("name") == name for tool in body.get("tools", [])), f"{name} is unavailable"
            call = {"type": "function_call", "id": f"fc_p6_{index}",
                    "call_id": f"call_p6_{index}", "name": name,
                    "arguments": json.dumps(args), "status": "completed"}
            events = [
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**call, "arguments": "", "status": "in_progress"}},
                {"type": "response.function_call_arguments.delta", "output_index": 0,
                 "item_id": call["id"], "delta": call["arguments"]},
                {"type": "response.function_call_arguments.done", "output_index": 0,
                 "item_id": call["id"], "arguments": call["arguments"]},
                {"type": "response.output_item.done", "output_index": 0, "item": call},
            ]
            output = [call]
        else:
            message = {"type": "message", "id": "msg_p6_knowledge", "role": "assistant", "status": "completed",
                       "content": [{"type": "output_text", "text": self.marker, "annotations": []}]}
            events = [
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**message, "status": "in_progress", "content": []}},
                {"type": "response.output_text.delta", "output_index": 0,
                 "item_id": message["id"], "content_index": 0, "delta": self.marker},
                {"type": "response.output_text.done", "output_index": 0,
                 "item_id": message["id"], "content_index": 0, "text": self.marker},
                {"type": "response.output_item.done", "output_index": 0, "item": message},
            ]
            output = [message]
        events.append({"type": "response.completed", "response": {
            "id": f"resp_p6_knowledge_{index}", "status": "completed", "output": output,
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}})
        return events

    def save(self):
        self.receipt.write_text(json.dumps({"requests": self.requests, "outputs": self.outputs,
            "ontology": self.ontology, "errors": self.errors, "usesRealProvider": False,
            "model": self.model, "marker": self.marker}, indent=2) + "\n")

    def start(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200 if self.path == "/health" else 404)
                self.end_headers()

            def do_POST(self):
                with owner.lock:
                    try:
                        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                        events = owner.events(body, self.path)
                    except BaseException:
                        owner.errors.append(traceback.format_exc())
                        owner.save()
                        self.send_error(400, "Synthetic Knowledge replay contract failed")
                        return
                    owner.save()
                data = ("".join("data: " + json.dumps(event) + "\n\n" for event in events)
                        + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--marker", required=True)
    args = parser.parse_args()
    provider = ScriptedProvider(args.receipt, args.model, args.marker)
    provider.save()
    server, thread = provider.start()
    print(f"mock-openai listening on {server.server_port}", flush=True)
    thread.join()
