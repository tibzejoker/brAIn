import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post } from "@nestjs/common";
import { BrainService, type SkillMeta, type SkillFull } from "@brain/core";

interface SaveSkillBody { name: string; content: string }

/**
 * CRUD over the network-wide skills (procedural-memory) library. Read access
 * spans every source (root + lib-bundled + personal); writes only ever touch
 * personal skills (`data/skills/`), bundled ones are read-only. The bus
 * request/reply service (BrainService.ensureSkillsResponder) is what nodes
 * use at runtime; this controller is the dashboard's view / edit / delete.
 */
@Controller("skills")
export class SkillsController {
  constructor(private readonly brain: BrainService) {}

  @Get()
  list(): SkillMeta[] {
    return this.brain.skillStore().list();
  }

  @Get(":name")
  get(@Param("name") name: string): SkillFull & { editable: boolean } {
    const store = this.brain.skillStore();
    const skill = store.load(name);
    if (!skill) throw new HttpException("Skill not found", HttpStatus.NOT_FOUND);
    return { ...skill, editable: store.isPersonal(name) };
  }

  @Post()
  save(@Body() body: SaveSkillBody): SkillFull {
    if (!body?.name || typeof body.content !== "string") {
      throw new HttpException("name + content required", HttpStatus.BAD_REQUEST);
    }
    try {
      return this.brain.skillStore().savePersonal(body.name, body.content);
    } catch (err) {
      throw new HttpException(err instanceof Error ? err.message : String(err), HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  @Delete(":name")
  remove(@Param("name") name: string): { deleted: string } {
    const store = this.brain.skillStore();
    if (!store.isPersonal(name)) {
      throw new HttpException("only personal skills can be deleted (bundled skills are read-only)", HttpStatus.FORBIDDEN);
    }
    if (!store.deletePersonal(name)) throw new HttpException("Skill not found", HttpStatus.NOT_FOUND);
    return { deleted: name };
  }
}
