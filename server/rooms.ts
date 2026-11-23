// The hostel's blocks and rooms, shared by the server and the browser.
// Blocks are lettered A, B, C… in order. A block with 13 rooms has A1–A12
// for students and AC, its common room, which is never allocated.
export type Block = {
  gender: "Female" | "Male";
  rooms: number;
  capacity: number;
  // Rooms whose capacity differs from the block's, such as { A3: 6 }.
  capacities?: Record<string, number>;
};
export type Room = {
  room: string;
  block: string;
  gender: string;
  capacity: number;
  common: boolean;
};

export const blockLetter = (index: number) => String.fromCharCode(65 + index);

export function parseBlocks(value: string | undefined): Block[] {
  try {
    const blocks = JSON.parse(value || "[]");
    return Array.isArray(blocks) ? blocks : [];
  } catch {
    return [];
  }
}

export function roomList(blocks: Block[]): Room[] {
  return blocks.flatMap((b, i) => {
    const block = blockLetter(i);
    return [
      ...Array.from({ length: b.rooms - 1 }, (_, n) => {
        const room = `${block}${n + 1}`;
        return {
          room,
          block,
          gender: b.gender,
          capacity: b.capacities?.[room] ?? b.capacity,
          common: false,
        };
      }),
      { room: `${block}C`, block, gender: b.gender, capacity: 0, common: true },
    ];
  });
}
