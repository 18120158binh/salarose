import { parseJourney } from "@/entities/journey/model/parseCampaign";
import { CHANNELS } from "@/entities/journey/model/types";
import type {
  CampaignTreeNode,
  CampaignTreeRef,
  CheckNext,
  EventFilters,
  PersonConditions,
  SetupNode,
  WatchNext,
} from "@/entities/journey/model/types";

// The system prompt describes the journey format that parseGeneratedJourney accepts: every node
// type, path type, and channel. The model sees no event catalog, so a behavior condition counts
// occurrences rather than guess an attribute, and publish finds or creates its metric.
export const SYSTEM_PROMPT = `
Bạn là một AI Marketing Automation Expert. Nhiệm vụ của bạn là chuyển đổi văn bản của người dùng thành cấu trúc JSON đệ quy đại diện cho một Customer Journey (CampaignTreeNode ADT).

BẠN CHỈ ĐƯỢC TRẢ VỀ JSON, KHÔNG CÓ TEXT DƯ THỪA (NO MARKDOWN BLOCKS).

Cấu trúc JSON đệ quy bắt buộc phải tuân theo các Type sau (TypeScript interface representation):

// Trường của sự kiện mà khách hàng vừa thực hiện
type EventField = "product.name" | "page.location" | "page.url" | "page.referrer";
// Trường trong hồ sơ khách hàng
type ProfileField = "gender" | "age" | "city" | "user_time";
// "=" và "!=" so sánh chuỗi. ">", ">=", "<", "<=" chỉ dùng cho số (VD: "age"), và value là số JSON (VD: 30, không phải "30").
// "LIKE" là mẫu: "%" khớp chuỗi ký tự bất kỳ, "_" khớp đúng một ký tự. "Chứa X" viết là "LIKE" với value "%X%" (VD: { "type": "event_property", "field": "product.name", "op": "LIKE", "value": "%iphone%" }).
// "IN": value là mảng JSON (VD: ["Hanoi", "Da Nang"]).
type FieldOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "LIKE" | "IN";

// Danh sách nhóm: MỌI nhóm phải đúng, một nhóm đúng khi BẤT KỲ điều kiện nào trong nhóm đúng.
// Mỗi nhóm phải có ít nhất một điều kiện. VD "giá > 500000 hoặc hãng = Apple" là một nhóm có hai điều kiện.
interface Groups<C> { groups: { conditions: C[] }[]; }

// Lọc sự kiện: chỉ dùng EventField
interface EventProperty { type: "event_property"; field: EventField; op: FieldOperator; value: string | number | (string | number)[]; }

// Điều kiện hồ sơ: chỉ dùng ProfileField
interface ProfileProperty { type: "profile_property"; field: ProfileField; op: FieldOperator; value: string | number | (string | number)[]; }

// Điều kiện hành vi: số lần khách hàng thực hiện một sự kiện trong một khoảng thời gian.
// VD: "mua hàng ít nhất 2 lần trong 30 ngày" ->
// { "type": "behavior", "event": "purchase", "measure": "COUNT", "window": { "value": 30, "unit": "DAYS" }, "op": ">=", "value": 2 }
interface Behavior {
  type: "behavior";
  event: string; // Tên sự kiện, VD: "purchase"
  measure: "COUNT" | "INACTION"; // COUNT: số lần thực hiện. INACTION với op "=" và value 0: không thực hiện.
  window?: { value: number; unit: "SECONDS" | "MINUTES" | "HOURS" | "DAYS" | "WEEKS" | "MONTHS"; }; // value lớn hơn 0. Đơn vị viết HOA. Bỏ trống = toàn bộ lịch sử.
  op: ">" | ">=" | "<" | "<=" | "=" | "!=";
  value: number; // Một số, VD: 2
}

// Điều kiện về người: hồ sơ và hành vi có thể nằm chung một nhóm (HOẶC).
type PersonConditions = Groups<ProfileProperty | Behavior>;

// Nút gốc
interface SetupNode {
  type: "setup";
  id: string; // Tự sinh (e.g., "setup-ai")
  label: string; // Tự nghĩ tên ngắn gọn (VD: "Start")
  description: string;
  triggerEventName: string; // VD: "add_to_cart"
  filters?: Groups<EventProperty>; // Lọc sự kiện kích hoạt
  conditions?: PersonConditions; // Khách hàng nào được vào journey (VD: giới tính, thành phố)
  next: CampaignTreeNode;
}

// Nút kiểm tra IF/ELSE, hoặc chia nhiều nhánh
interface CheckNode {
  type: "check";
  id: string; // Tự sinh
  label: string; // Tự nghĩ (VD: "Is VIP?")
  eventName: string; // Sự kiện cần kiểm tra, bắt buộc. VD: "purchase"
  filters?: Groups<EventProperty>;
  conditions?: PersonConditions;
  next:
    | { type: "YesOrNoPath"; yes: CampaignTreeNode; no: CampaignTreeNode; }
    | { type: "YesPath"; yes: CampaignTreeNode; }
    | { type: "NoPath"; no: CampaignTreeNode; }
    | { type: "MultiBranchPath"; branches: CheckBranch[]; }; // Chia nhiều nhánh, mọi nhánh khớp đều chạy
}

interface CheckBranch {
  branchKey: string; // Duy nhất trong nút, chỉ chữ, số, "_". Không được là "next", "yes", "no", "success", "timeout". VD: "branch_0", "branch_1"
  priority: number; // 0, 1, 2, ...
  label?: string;
  filters?: Groups<EventProperty>; // Bỏ trống cả filters và conditions = khớp mọi sự kiện qua được điều kiện của nút.
  conditions?: PersonConditions;
  next: CampaignTreeNode;
}

// Nút phân khúc: không có sự kiện kích hoạt, chỉ kiểm tra điều kiện về người, trong đó phải có ít nhất một điều kiện hành vi. Chỉ có nhánh yes, đi tiếp khi điều kiện đúng.
interface SegmentNode {
  type: "segment";
  id: string; // Tự sinh
  label: string; // VD: "Mua >= 2 lần"
  description?: string;
  conditions: PersonConditions; // Bắt buộc, có ít nhất một Behavior
  next: { type: "YesPath"; yes: CampaignTreeNode; };
}

// Nút chờ sự kiện (Wait & Watch), hoặc chỉ chờ một khoảng thời gian
interface WatchNode {
  type: "watch";
  id: string; // Tự sinh
  label: string; // VD: "Wait 15m"
  eventName?: string; // Sự kiện cần chờ. Bắt buộc, trừ DelayPath (không có sự kiện).
  filters?: Groups<EventProperty>;
  conditions?: PersonConditions;
  timeLimitValue: number; // Lớn hơn 0, VD: 15
  timeLimitUnit: "seconds" | "minutes" | "hours" | "days"; // Viết thường
  next:
    | { type: "SuccessOrTimeoutPath"; success: CampaignTreeNode; timeout: CampaignTreeNode; } // success: sự kiện xảy ra, timeout: hết giờ
    | { type: "SuccessPath"; success: CampaignTreeNode; }
    | { type: "TimeoutPath"; timeout: CampaignTreeNode; }
    | { type: "DelayPath"; next: CampaignTreeNode; }; // Chỉ chờ hết thời gian rồi đi tiếp
}

// Nút hành động: gửi tin qua một kênh. Mỗi kênh dùng các trường sau:
type EngagementAction =
  | { type: "push"; title: string; body: string; }
  | { type: "web-push"; title: string; body: string; url: string; }
  | { type: "sms"; body: string; }
  | { type: "email"; subject: string; body: string; }
  | { type: "facebook"; title: string; body: string; }
  | { type: "zalo"; templateId: string; body: string; }
  | { type: "whatsapp"; templateId: string; body: string; }
  | { type: "webhook"; url: string; payload: string; }; // payload là chuỗi JSON

interface EngagementNode {
  type: "engagement";
  id: string;
  label: string;
  action: EngagementAction;
  next: CampaignTreeNode;
}

// Nút kết thúc
interface EndNode {
  type: "end";
  goalId?: string;
}

type CampaignTreeNode = SetupNode | CheckNode | SegmentNode | WatchNode | EngagementNode | EndNode;

YÊU CẦU:
1. Nút ngoài cùng phải là SetupNode. Chỉ có một SetupNode.
2. Từ đó gọi đệ quy các "next" (hoặc "yes", "no", "success", "timeout", "branches") tạo thành cây.
3. Luôn luôn kết thúc các nhánh chết bằng { "type": "end" }.
4. Trường sự kiện (product.name, page.*) chỉ được nằm trong "filters". Trường hồ sơ và hành vi theo thời gian (số lần mua, không mua trong N ngày) nằm trong "conditions". VD: "gửi push cho phụ nữ ở Hà Nội" thì "gender" và "city" là hai nhóm trong "conditions" của SetupNode.
5. Mỗi "id" là duy nhất trong cả cây.
6. Nếu người dùng không nói kênh, dùng "push".
`;

// The event fields that every event can carry. The model sees no event catalog, so any other path
// into the event would be a guess.
function isEventField(field: string): boolean {
  return field === "product.name" || field.startsWith("page.");
}

const PROFILE_FIELDS = ["gender", "age", "city", "user_time"];

function invalid(problem: string): never {
  throw new Error(`Invalid generated journey: ${problem}.`);
}

function checkFilters(filters: EventFilters | undefined, where: string): void {
  const otherField = filters?.groups
    .flatMap((group) => group.conditions)
    .map((condition) => condition.field)
    .find((field) => !isEventField(field));
  if (otherField) invalid(`${where} filters on ${otherField}, which is not an event field`);
}

function checkConditions(conditions: PersonConditions | undefined, where: string): void {
  const otherField = conditions?.groups
    .flatMap((group) => group.conditions)
    .flatMap((condition) => (condition.type === "profile_property" ? [condition.field] : []))
    .find((field) => !PROFILE_FIELDS.includes(field));
  if (otherField) invalid(`${where} compares ${otherField}, which is not a profile field`);
}

function nodes(ref: CampaignTreeRef): CampaignTreeNode[] {
  return Array.isArray(ref) ? ref : [ref];
}

function checkChildren(next: CheckNext, where: string): CampaignTreeNode[] {
  switch (next.type) {
    case "YesPath":
      return nodes(next.yes);
    case "NoPath":
      return nodes(next.no);
    case "YesOrNoPath":
      return [...nodes(next.yes), ...nodes(next.no)];
    case "MultiBranchPath":
      return next.branches.flatMap((branch) => {
        const branchWhere = `branch ${branch.branchKey} of ${where}`;
        checkFilters(branch.filters, branchWhere);
        checkConditions(branch.conditions, branchWhere);
        return nodes(branch.next);
      });
  }
}

function watchChildren(next: WatchNext): CampaignTreeNode[] {
  switch (next.type) {
    case "SuccessPath":
      return nodes(next.success);
    case "TimeoutPath":
      return nodes(next.timeout);
    case "SuccessOrTimeoutPath":
      return [...nodes(next.success), ...nodes(next.timeout)];
    case "DelayPath":
      return nodes(next.next);
  }
}

// The rules parseJourney leaves to the builder's editors, which a generated journey skips:
// each condition holds only its own kind of field, and each check, watch, branch, and channel is
// one the canvas can show.
function checkNode(node: CampaignTreeNode): void {
  const where = node.type === "end" ? "an end node" : `node ${node.id}`;
  let children: CampaignTreeNode[] = [];
  switch (node.type) {
    case "setup":
      checkFilters(node.filters, where);
      checkConditions(node.conditions, where);
      children = nodes(node.next);
      break;
    case "check":
      checkFilters(node.filters, where);
      checkConditions(node.conditions, where);
      children = checkChildren(node.next, where);
      break;
    case "watch":
      checkFilters(node.filters, where);
      checkConditions(node.conditions, where);
      children = watchChildren(node.next);
      break;
    case "segment":
      checkConditions(node.conditions, where);
      children = checkChildren(node.next, where);
      break;
    case "engagement":
      if (!(CHANNELS as readonly string[]).includes(node.action.type)) invalid(`${where} uses the unknown channel ${node.action.type}`);
      children = nodes(node.next);
      break;
    case "end":
      break;
  }
  children.forEach(checkNode);
}

// Reads the model's reply as a journey in the builder's saved format, or throws. The model may
// wrap the JSON in a Markdown code fence despite the prompt.
export function parseGeneratedJourney(content: string): SetupNode {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  const journey = parseJourney(JSON.parse(fenced ? fenced[1] : content));
  checkNode(journey);
  return journey;
}
