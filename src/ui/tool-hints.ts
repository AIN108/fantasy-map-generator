import { MAX_SPAN_LENGTH } from "../infra.ts";

export type EditTarget = "terrain" | "city" | "border" | "infra" | "resource";
export type InfraTool = "road" | "rail" | "sea" | "bridge" | "tunnel" | "port" | "facility" | "move" | "toggleMode" | "erase";
export type CityTool = "move" | "add" | "delete" | "rename" | "capital" | "newState";

export const INFRA_TOOL_HINTS: Record<InfraTool, string> = {
  road: "출발점에서 도착점까지 끌어 놓으면 지형을 따라 도로가 생깁니다. 도시 근처에서 놓으면 도시에 붙고, 직접 놓은 다리·터널도 길로 씁니다.",
  rail: "출발점에서 도착점까지 끌어 놓으면 철도가 생깁니다. 철도는 급경사를 피해 산을 크게 돌아갑니다.",
  sea: "항구에서 다른 항구까지 끌어 놓으면 바다를 따라 항로가 생깁니다. 얕은 연안보다 깊은 바다를 조금 더 선호합니다.",
  bridge: `육지에서 물 건너편 육지까지 끌어 놓으면 곧은 다리가 놓입니다 (강·호수·해협, ${MAX_SPAN_LENGTH}px까지). 도로는 도로용, 철도는 철도용 다리만 건넙니다.`,
  tunnel: `두 육지 지점 사이를 끌어 놓으면 곧은 터널이 놓입니다. 산을 관통하거나 바다 밑으로 지날 수 있습니다 (${MAX_SPAN_LENGTH}px까지). 도로는 도로용, 철도는 철도용 터널만 지납니다.`,
  port: "바다에 닿은 해안을 누르면 항구가 생깁니다.",
  facility: "고른 종류의 시설물을 누른 자리에 둡니다. 등대는 해안에만, 공항은 평지에만 둘 수 있습니다.",
  toggleMode: "다리·터널을 누르면 도로용 ↔ 철도용이 바뀝니다. 그 위를 지나던 원래 용도의 길은 다른 길로 다시 이어 봅니다.",
  move: "항구·시설물·다리·터널을 끌어 옮깁니다. 다리·터널은 끝점을 끌면 그 끝만, 가운데를 끌면 통째로 옮겨지고, 지나던 도로·철도가 따라갑니다. 항구를 옮기면 이어진 항로도 다시 계산합니다.",
  erase: "누른 곳에서 가장 가까운 시설을 지웁니다. 자동 다리·터널 표기를 누르면 그 표기만 숨깁니다.",
};

export const CITY_TOOL_HINTS: Record<CityTool, string> = {
  move: "도시를 끌어 옮깁니다. 수도를 옮기면 그 자리가 수도의 나라 땅이 됩니다.",
  add: "빈 땅을 누르면 도시가 생깁니다. 이름은 자동으로 붙고, 나중에 바꿀 수 있습니다.",
  delete: "도시를 누르면 지웁니다. 수도는 지울 수 없습니다.",
  rename: "도시를 누르고 새 이름을 입력합니다.",
  capital: "도시를 누르면 그 도시가 속한 나라의 수도가 됩니다.",
  newState: "도시를 누르면 그 도시를 수도로 하는 새 나라가 생깁니다. 원래 나라의 영토는 두 수도 중 가까운 쪽으로 나뉩니다.",
};

export type ResourceTool = "add" | "erase";

export const RESOURCE_TOOL_HINTS: Record<ResourceTool, string> = {
  add: "고른 자원을 누른 칸에 놓습니다. 이미 자원이 있으면 바꿉니다. 어장·진주는 바다·호수에, 석유는 육지·바다 어디든, 나머지는 육지에만 둘 수 있습니다.",
  erase: "누른 곳에서 가장 가까운 자원을 지웁니다. 자동으로 놓인 자원도 지울 수 있고, '자원 자동 배치로'로 되살립니다.",
};

export const BORDER_HINT = "고른 국가의 영토로 칠합니다. 다른 나라의 수도 자리는 칠해지지 않습니다.";
