import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async create(email: string, username: string, password: string): Promise<User> {
    const exists = await this.usersRepo.findOne({
      where: [{ email }, { username }],
    });
    if (exists) {
      throw new ConflictException('邮箱或用户名已存在');
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.usersRepo.create({
      email,
      username,
      passwordHash,
    });
    return this.usersRepo.save(user);
  }

  findByEmailOrUsername(identifier: string): Promise<User | null> {
    return this.usersRepo.findOne({
      where: [{ email: identifier }, { username: identifier }],
    });
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  async findAll(): Promise<User[]> {
    return this.usersRepo.find({ order: { createdAt: 'DESC' } });
  }

  sanitize(user: User): Omit<User, 'passwordHash'> {
    const { passwordHash: _ph, ...rest } = user;
    return rest;
  }
}
