import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  username: string;

  /**
   * 密码哈希：**绝不能出现在任何响应里**。
   * `select: false` 让所有查询默认不带出该列——包括 `leftJoinAndSelect('x.author', 'author')`
   * 这类关系加载（它们不会经过 `UsersService.sanitize`，曾经把该列泄露到公开列表接口）。
   * 只有显式 `.addSelect('user.passwordHash')` 才取得到，目前仅登录校验需要。
   */
  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false })
  passwordHash: string;

  @Column({ name: 'avatar_url', type: 'varchar', length: 255, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'enum', enum: ['user', 'admin'], default: 'user' })
  role: 'user' | 'admin';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
