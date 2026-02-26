import { BaseEntity, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

export interface DeploymentStepConfig {
   step: string;
   name: string;
   cmd: string;
   args: string[];
   /** If true, this step triggers a process restart — remaining steps resume on module init */
   triggersRestart?: boolean;
   /** If true, this step runs after module init (post-restart verification) */
   runsOnModuleInit?: boolean;
   /** If true, this step is permanently skipped during deployment */
   skip?: boolean;
}

@Entity()
export class DeploymentProject extends BaseEntity {
   @PrimaryGeneratedColumn()
   id: number;

   /** Unique slug e.g. "backend", "frontend" */
   @Column({ unique: true })
   slug: string;

   @Column()
   name: string;

   /** Absolute path to the project working directory */
   @Column()
   workDir: string;

   /** PM2 process name (if applicable, used for restart step) */
   @Column({ nullable: true })
   pm2ProcessName: string | null;

   /** JSON-serialized DeploymentStepConfig[] */
   @Column({ type: "text" })
   steps: string;

   /** Git branch to watch for webhook deployments */
   @Column({ default: "master" })
   branch: string;

   @Column({ default: true })
   enabled: boolean;

   @CreateDateColumn()
   created_at: Date;

   @UpdateDateColumn()
   updated_at: Date;

   getSteps(): DeploymentStepConfig[] {
      return JSON.parse(this.steps);
   }

   setSteps(steps: DeploymentStepConfig[]) {
      this.steps = JSON.stringify(steps);
   }
}
