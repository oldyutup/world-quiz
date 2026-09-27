import RAPIER from '@dimforge/rapier3d-compat';
import { BOWLING, CAR, GROUP, groups, roadHeight, OBSTACLES, type StuntObstacle } from './config';
import { product, yaw } from '../ragdoll/math';
export interface CarInput { throttle: number; brake: number; steer: number; }
export const steeringRate = (speed: number) => 1.5 / (1 + Math.abs(speed) / 9) * Math.min(1, Math.abs(speed) / 3);
/** One dynamic chassis, four short support rays, no wheel bodies or joints.
 * Rotation is deliberately arcade-controlled; collisions and vertical travel are Rapier.
 * The installed raycast vehicle API was evaluated; its per-wheel tire/slip tuning adds
 * unnecessary degrees of freedom for a single straight stunt runway. */
export interface StuntHit { hit: boolean; age: number; speed: number; side: number; }
export class StuntCar {
  readonly collider: RAPIER.Collider;
  readonly props: { collider: RAPIER.Collider; state: StuntHit }[];
  hitCount = 0;
  readonly stuntStates: StuntHit[];
  readonly body: RAPIER.RigidBody;
  heading = 0; pitch = 0; grounded = false;
  constructor(readonly world: RAPIER.World, readonly obstacles: StuntObstacle[] = OBSTACLES) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,BOWLING.startHeight+CAR.rideHeight,BOWLING.startZ).lockRotations().setCcdEnabled(true).setCanSleep(true));
    this.collider = world.createCollider(RAPIER.ColliderDesc.cuboid(.78,.23,1.65).setMass(CAR.mass).setFriction(.08).setRestitution(.05).setCollisionGroups(groups(GROUP.car, GROUP.ground | GROUP.carStop)),this.body);
    // Breakaway scenery uses actual overlap with the chassis, never support rays.
    // No loose Rapier bodies: hitting a prop cannot launch or trap the vehicle.
    this.props=obstacles.map(c=>({collider:world.createCollider(RAPIER.ColliderDesc.ball(c.half[0]).setTranslation(...c.at).setSensor(true).setCollisionGroups(groups(GROUP.carStop,GROUP.car))),state:{hit:false,age:0,speed:0,side:1}}));
    this.stuntStates=this.props.map(p=>p.state);
  }
  get speed() { const v=this.body.linvel(); return Math.hypot(v.x,v.z); }
  reset() {
    this.heading=this.pitch=0;this.grounded=false;this.hitCount=0;
    for(const [i,prop] of this.props.entries()){const c=this.obstacles[i];Object.assign(prop.state,{hit:false,age:0,speed:0,side:1});prop.collider.setTranslation({x:c.at[0],y:c.at[1],z:c.at[2]});prop.collider.setShape(new RAPIER.Ball(c.half[0]));prop.collider.setEnabled(c.active);}
    this.body.setTranslation({x:0,y:BOWLING.startHeight+CAR.rideHeight,z:BOWLING.startZ},true);
    this.body.setRotation({x:0,y:0,z:0,w:1},true);
    this.body.setLinvel({x:0,y:0,z:0},true);this.body.setAngvel({x:0,y:0,z:0},true);
    this.body.resetForces(true);this.body.resetTorques(true);
  }
  step(input: CarInput, runoff = false) {
    const dt=BOWLING.step,p=this.body.translation(),v=this.body.linvel();
    let impactLoss=0;
    this.props.forEach((prop,i)=>{
      if(prop.state.hit){prop.state.age+=dt;return;}
      if(!this.world.intersectionPair(this.collider,prop.collider))return;
      const c=this.obstacles[i];
      Object.assign(prop.state,{hit:true,age:0,speed:this.speed,side:c.at[0]>=p.x?1:-1});
      prop.collider.setEnabled(false);this.hitCount++;
      impactLoss+=this.speed*(.12+c.half[0]*.045);
      this.heading-=prop.state.side*.075;
    });
    const heights: number[]=[];
    for(const z of [-1.1,1.1]) for(const x of [-.6,.6]) {
      const origin={x:p.x+x*Math.cos(this.heading)+z*Math.sin(this.heading),y:p.y+.7,z:p.z+z*Math.cos(this.heading)-x*Math.sin(this.heading)};
      const hit=this.world.castRay(new RAPIER.Ray(origin,{x:0,y:-1,z:0}),3.2,true,undefined,groups(GROUP.car,GROUP.ground),undefined,this.body);
      heights.push(hit ? origin.y-hit.timeOfImpact : NaN);
    }
    const valid=heights.filter(Number.isFinite),ground=valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : -100;
    this.grounded=valid.length>=2 && p.y-ground < CAR.rideHeight+.22;
    let vy=v.y;
    if(this.grounded) {
      const slope=(roadHeight(p.z+.1)-roadHeight(p.z-.1))/.2;
      const surfaceVelocity=p.z<BOWLING.rampLip-.2?slope*v.z:0;
      // Suspension can push the chassis up, never pull it down over a crest.
      vy+=Math.max(0,Math.min(100,(ground+CAR.rideHeight-p.y)*120-(v.y-surfaceVelocity)*18+20))*dt;
      const target=heights.every(Number.isFinite)?Math.atan2((heights[2]+heights[3]-heights[0]-heights[1])/2,2.2):0;
      this.pitch+=(target-this.pitch)*Math.min(1,dt*12);
      const steer=Math.max(-1,Math.min(1,input.steer));
      this.heading=Math.max(-.6,Math.min(.6,this.heading+steer*steeringRate(this.speed)*dt));
    }
    const sin=Math.sin(this.heading),cos=Math.cos(this.heading);
    let forward=Math.max(0,v.x*sin+v.z*cos-Math.min(this.speed*.55,impactLoss)),side=v.x*cos-v.z*sin;
    if(this.grounded) {
      const throttle=runoff?0:Math.max(0,Math.min(1,input.throttle));
      const brake=runoff&&p.z>BOWLING.rampLip+2?1:Math.max(0,Math.min(1,input.brake));
      forward=Math.max(0,Math.min(CAR.maxSpeed,forward+(throttle*CAR.acceleration + (roadHeight(p.z-.2)-roadHeight(p.z+.2))/.4*9.81 -brake*CAR.brake-(throttle===0?CAR.coast:0))*dt));
      side*=Math.exp(-10*dt);
    }
    this.body.setLinvel({x:sin*forward+cos*side,y:vy,z:cos*forward-sin*side},true);
    this.body.setRotation(product(yaw(this.heading),{x:-Math.sin(this.pitch/2),y:0,z:0,w:Math.cos(this.pitch/2)}),true);
  }
}
