export interface DesignColumn { name: string; definition: string; primary: boolean; foreign: boolean; nullable: boolean }
export interface DesignRelation { from: string; column: string; to: string; target: string; optional: boolean; unique: boolean }
export interface DesignTable { name: string; columns: DesignColumn[]; constraints: string[] }
export interface DatabaseDesign { tables: DesignTable[]; relations: DesignRelation[]; sql: string }

// Parse this project's CREATE TABLE statements so the review screen stays in sync with schema.sql.
export function parseDatabaseDesign(sql: string): DatabaseDesign {
  const relations: DesignRelation[] = [];
  const tables = Array.from(sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g), ([, name, body]) => {
    const lines = body.split("\n").map(line => line.trim().replace(/,$/, "")).filter(Boolean);
    const constraints = lines.filter(line => /^(CONSTRAINT|UNIQUE KEY|KEY)\b/.test(line));
    const columns = lines.filter(line => !constraints.includes(line)).map(line => {
      const [, columnName, definition] = line.match(/^(\w+)\s+(.+)$/)!;
      return { name: columnName, definition, primary: definition.includes("PRIMARY KEY"), foreign: constraints.some(item => item.includes(`FOREIGN KEY (${columnName})`)), nullable: !/NOT NULL|PRIMARY KEY/.test(definition) };
    });
    for (const constraint of constraints) {
      const fk = constraint.match(/FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\)/);
      if (fk) relations.push({ from: name, column: fk[1], to: fk[2], target: fk[3], optional: columns.find(column => column.name === fk[1])!.nullable, unique: columns.find(column => column.name === fk[1])!.definition.includes("UNIQUE") });
    }
    return { name, columns, constraints };
  });
  return { tables, relations, sql };
}
