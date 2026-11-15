import assert from "node:assert/strict";
import { test } from "node:test";
import { worldPlaces } from "../src/places.ts";
import { searchPlaces, type SearchPlace } from "../src/search.ts";
import { generateWorld } from "../src/world.ts";

const world = generateWorld({ seed: "장소 검색", cells: 1200, states: 3, citiesPerState: 3 });

test("장소 좌표는 현재 지도의 셀과 일치하고 검색이 지도 데이터를 바꾸지 않는다", () => {
  const before = JSON.stringify(world);
  const places = worldPlaces(world);
  assert.equal(places.filter((p) => p.category === "city").length, world.cities.length);
  assert.equal(places.filter((p) => p.category === "state").length, world.states.length);
  assert.equal(new Set(places.map((p) => p.key)).size, places.length);
  for (const p of places) {
    assert.equal(p.x, world.mesh.x[p.cell]);
    assert.equal(p.y, world.mesh.y[p.cell]);
  }
  searchPlaces(places, "수도");
  assert.equal(JSON.stringify(world), before);
});

test("국가 이름으로 그 나라 도시를 찾고 수도만 좁힌다", () => {
  const places = worldPlaces(world), state = world.states[0];
  const cities = searchPlaces(places, state.name, "city");
  assert.deepEqual(cities.map((p) => p.cell), world.cities.filter((c) => c.state === state.id).map((c) => c.cell));
  const capital = searchPlaces(places, `${state.name} 수도`, "city");
  assert.equal(capital.length, 1);
  assert.equal(capital[0].cell, state.capitalCell);
});

test("이름 바꾸기·도시 삭제 뒤에는 새 상태만 검색된다", () => {
  const city = world.cities[0];
  const changed = { ...world, cities: [{ ...city, name: "새로 지은 도시" }, ...world.cities.slice(1)] };
  assert.equal(searchPlaces(worldPlaces(changed), "새로 지은", "city").length, 1);
  const removed = { ...world, cities: world.cities.slice(1) };
  assert.ok(!worldPlaces(removed).some((p) => p.key === `city:${city.cell}`));
});

test("이름 없는 항구·시설도 종류로 찾는다", () => {
  const cell = world.cities[0].cell;
  const changed = { ...world, ports: [{ cell }], facilities: [{ cell, kind: "castle" as const }] };
  const places = worldPlaces(changed);
  assert.equal(searchPlaces(places, "항구", "port")[0].cell, cell);
  assert.equal(searchPlaces(places, "성", "facility")[0].cell, cell);
});

test("한글 조합·전각 영문·대소문자·공백 차이를 처리하고 이름 일치를 우선한다", () => {
  const places: SearchPlace[] = [
    { key: "1", category: "city", name: "별빛 항구", detail: "Westmarch 소속" },
    { key: "2", category: "state", name: "Westmarch", detail: "국가" },
    { key: "3", category: "city", name: "별빛", detail: "수도" },
  ];
  assert.deepEqual(searchPlaces(places, "  ＷＥＳＴＭＡＲＣＨ  ").map((p) => p.key), ["2", "1"]);
  assert.deepEqual(searchPlaces(places, "별빛".normalize("NFD")).map((p) => p.key), ["3", "1"]);
  assert.equal(searchPlaces(places, "별빛    수도").length, 1);
  assert.deepEqual(searchPlaces(places, "없는 곳"), []);
  assert.deepEqual(searchPlaces([], ""), []);
});
