def validate(data):
    if not isinstance(data, dict):
        raise ValueError("kapp 必须是对象")
    entries = data.get("groups", [])
    if not isinstance(entries, list):
        raise ValueError("groups 必须是列表")
    if not entries:
        return
    graph = data.get("graph")
    if not isinstance(graph, dict):
        raise ValueError("分组需要 API graph")
    if "__group__" in graph:
        raise ValueError("graph 节点 __group__ 与分组开关保留 ID 冲突")
    ids = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("groups 条目必须是对象")
        gid = entry.get("id")
        if not isinstance(gid, str) or not gid.strip() or ":" in gid:
            raise ValueError("分组 id 必须是非空字符串且不能含冒号")
        if gid in ids:
            raise ValueError("分组 id 重复：%s" % gid)
        ids.add(gid)
        label = entry.get("label")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("分组 %s 的 label 必须是非空字符串" % gid)
        if type(entry.get("default")) is not bool:
            raise ValueError("分组 %s 的 default 必须是 bool" % gid)
        if entry.get("mode") not in ("bypass", "mute"):
            raise ValueError("分组 %s 的 mode 必须是 bypass 或 mute" % gid)
        nodes = entry.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise ValueError("分组 %s 的 nodes 必须是非空列表" % gid)
        seen = set()
        for nid in nodes:
            if not isinstance(nid, str) or not nid.strip() or nid not in graph:
                raise ValueError("分组 %s 的节点必须是 graph 中的完整字符串 ID：%s" % (gid, nid))
            if nid in seen:
                raise ValueError("分组 %s 的节点重复：%s" % (gid, nid))
            seen.add(nid)
    metadata = data.get("group_nodes")
    if not isinstance(metadata, dict):
        raise ValueError("group_nodes 必须提供被控节点的 ports 数据")
    for nid in graph:
        if nid not in metadata:
            raise ValueError("group_nodes 缺少节点 %s 的 ports 数据" % nid)
    for nid, ports in metadata.items():
        if not isinstance(nid, str) or nid not in graph:
            raise ValueError("group_nodes 节点不在 graph 中：%s" % nid)
        if not isinstance(ports, dict) or not isinstance(ports.get("inputs"), list):
            raise ValueError("group_nodes[%s].inputs 必须是列表" % nid)
        outputs = ports.get("outputs")
        if not isinstance(outputs, list) or any(not isinstance(t, str) for t in outputs):
            raise ValueError("group_nodes[%s].outputs 必须是字符串列表" % nid)
        names = set()
        for port in ports["inputs"]:
            if not isinstance(port, dict):
                raise ValueError("group_nodes[%s] 的输入 socket 必须是对象" % nid)
            name = port.get("name")
            if not isinstance(name, str) or not name.strip() or name in names:
                raise ValueError("group_nodes[%s] 的 input name 必须非空且唯一" % nid)
            if not isinstance(port.get("type"), str):
                raise ValueError("group_nodes[%s] 的 input type 必须是字符串" % nid)
            names.add(name)


def spec_items(data, saved):
    return [{"node": "__group__", "input": entry["id"], "label": entry["label"],
             "widget": "toggle", "kind": "bool", "spec": {"type": "BOOLEAN"},
             "default": saved.get("__group__:" + entry["id"], entry["default"]),
             "node_type": "", "node_title": "分组开关"}
            for entry in data.get("groups", [])]


def split_values(data, values):
    ids = {entry["id"] for entry in data.get("groups", [])}
    ordinary, switches, failed = {}, {}, []
    for key, value in (values or {}).items():
        text = str(key)
        if not text.startswith("__group__:"):
            ordinary[key] = value
        elif text[len("__group__:"):] not in ids:
            failed.append({"key": key, "why": "未知分组"})
        elif type(value) is not bool:
            failed.append({"key": key, "why": "分组开关必须是 bool"})
        else:
            switches[key] = value
    return ordinary, switches, failed


def disabled_nodes(data, switches):
    disabled = {}
    for entry in data.get("groups", []):
        if switches.get("__group__:" + entry["id"], entry["default"]):
            continue
        for nid in entry["nodes"]:
            if disabled.get(nid) != "mute":
                disabled[nid] = entry["mode"]
    return disabled


def _is_link(value):
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and type(value[1]) is int)


def _compatible(left, right):
    left = {t.strip() for t in left.split(",")}
    right = {t.strip() for t in right.split(",")}
    return bool((left | right) & {"", "*"} or left & right)


def _passthrough(ports, slot, target_type):
    inputs = ports["inputs"]
    if not inputs:
        return None
    same = inputs[slot] if 0 <= slot < len(inputs) else None
    if target_type.strip() in ("", "*"):
        return same if same is not None else inputs[0]
    outputs = ports["outputs"]
    output_type = outputs[slot] if 0 <= slot < len(outputs) else ""

    def matches(port):
        return (_compatible(port["type"], output_type)
                and _compatible(port["type"], target_type))

    if same is not None and matches(same):
        return same
    for port in inputs:
        if port["type"] == target_type:
            return port
    return next((port for port in inputs if matches(port)), None)


def rewrite(graph, metadata, disabled):
    def resolve(link, target_type, trail):
        nid, slot = link
        mode = disabled.get(nid)
        if mode is None:
            return link
        if mode == "mute":
            return None
        marker = (nid, slot)
        if marker in trail:
            raise ValueError("分组 bypass 连线形成环：%s" % " -> ".join(
                "%s[%s]" % item for item in trail + (marker,)))
        port = _passthrough(metadata[nid], slot, target_type)
        value = (graph[nid].get("inputs") or {}).get(port["name"]) if port else None
        if not _is_link(value):
            return None
        return resolve(value, target_type, trail + (marker,))

    remaining = {nid: node for nid, node in graph.items() if nid not in disabled}
    for nid, node in remaining.items():
        types = {port["name"]: port["type"]
                 for port in metadata.get(nid, {}).get("inputs", [])}
        inputs = node.get("inputs") or {}
        for name, value in list(inputs.items()):
            if not _is_link(value):
                continue
            link = resolve(value, types.get(name, ""), ())
            if link is None:
                del inputs[name]
            else:
                inputs[name] = link
    return remaining
