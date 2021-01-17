<?php

namespace App\Http\Controllers;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Routing\ResponseFactory;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

class UpdateController extends Controller
{
    const SUCCESS = 0;
    const ERROR = 1;

    private $output = "";

    /**
     * @param Request $request
     *
     * @return Application|ResponseFactory|Response
     */
    public function update(Request $request)
    {
        $status = UpdateController::SUCCESS;
        $output = "";

        try {
            // Pull from github
            $base_command = "cd ".base_path();
            $process      = Process::fromShellCommandline("$base_command && git checkout master");
            $process->start();
            $process->wait($this->onError());
            $output .= $process->getOutput();

            // Pull
            $process = Process::fromShellCommandline("$base_command && git pull");
            $process->start();
            $process->wait($this->onError());
            $output .= $process->getOutput();

            // Install composer dependencies
            $process = Process::fromShellCommandline("$base_command && composer install");
            $process->start();
            $process->wait($this->onError());
            $output .= $process->getOutput();

            // Install npm dependencies
            $process = Process::fromShellCommandline("$base_command && npm install");
            $process->start();
            $process->wait($this->onError());
            $output .= $process->getOutput();

            // Run npm production
            $process = Process::fromShellCommandline("$base_command && npm run prod");
            $process->start();

        } catch (\Exception $e) {
            $status = UpdateController::ERROR;
        }

        return response([
            "status" => $status,
            "output" => $output
        ]);
    }

    /**
     * @return \Closure
     */
    private function onError()
    {
        return function ($type, $buffer) {
            if (Process::ERR === $type) {
                if (Str::contains(Str::lower($buffer), "error"))
                    throw new \Exception("An error has occurred!$buffer");
            }
        };
    }
}
